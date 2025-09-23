#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const yaml = require("js-yaml");
const { nanoid } = require("nanoid");
const OpenAI = require("openai");
const { Octokit } = require("@octokit/rest");
const { graphql } = require("@octokit/graphql");
const { hideBin } = require("yargs/helpers");
const yargs = require("yargs/yargs");

dotenv.config();

const DEFAULT_TICKET_PATH = "tickets/sample.md";
const MAX_FILES = 5;
const MAX_FILE_SIZE = 200 * 1024; // 200KB

function requireEnv(name, fallback) {
  const value = process.env[name] || fallback;
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "ticket";
}

function parseTicket(ticketPath) {
  const raw = fs.readFileSync(ticketPath, "utf8");
  let ticketBlock = null;

  const frontMatterMatch = raw.match(/^---\n([\s\S]+?)\n---/);
  if (frontMatterMatch) {
    ticketBlock = frontMatterMatch[1];
  } else {
    const fencedMatch = raw.match(/```(?:yaml)?\n([\s\S]*?)\n```/);
    if (fencedMatch) {
      ticketBlock = fencedMatch[1];
    } else {
      const headingMatch = raw.match(/#\s*shipyard:ticket[\s\S]*/i);
      if (headingMatch) {
        ticketBlock = headingMatch[0].replace(/^#\s*shipyard:ticket\s*/i, "");
      }
    }
  }

  if (!ticketBlock) {
    throw new Error("Unable to locate ticket YAML block.");
  }

  let ticket;
  try {
    ticket = yaml.load(ticketBlock);
  } catch (error) {
    throw new Error(`Failed to parse ticket YAML: ${error.message}`);
  }

  if (!ticket || typeof ticket !== "object") {
    throw new Error("Ticket YAML did not produce an object.");
  }

  const requiredKeys = ["title", "why", "scope", "dod"];
  for (const key of requiredKeys) {
    if (!ticket[key]) {
      throw new Error(`Ticket missing required field: ${key}`);
    }
  }

  if (!Array.isArray(ticket.scope) || ticket.scope.length === 0) {
    throw new Error("Ticket scope must be a non-empty array.");
  }

  ticket.scope = ticket.scope.map((entry) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error("Ticket scope entries must be non-empty strings.");
    }
    const trimmed = entry.trim();
    const isDirectory = trimmed.endsWith("/");
    const normalized = path.posix.normalize(
      isDirectory ? trimmed.replace(/\/+$/, "") : trimmed
    );
    if (normalized.startsWith("../")) {
      throw new Error(`Scope path escapes repository: ${entry}`);
    }
    const finalPath = normalized.replace(/^\.\//, "");
    return isDirectory ? `${finalPath}/` : finalPath;
  });

  if (ticket.guardrails && !Array.isArray(ticket.guardrails)) {
    throw new Error("Ticket guardrails must be an array when provided.");
  }

  return ticket;
}

async function fetchScopeFiles(octokit, owner, repo, ref, scope) {
  const files = [];
  for (const scopePath of scope) {
    if (scopePath.endsWith("/")) {
      throw new Error(`Scope path is a directory, expected file: ${scopePath}`);
    }
    let response;
    try {
      response = await octokit.repos.getContent({
        owner,
        repo,
        path: scopePath,
        ref,
      });
    } catch (error) {
      if (error.status === 404) {
        throw new Error(`Scope path not found in base branch: ${scopePath}`);
      }
      throw error;
    }

    if (Array.isArray(response.data)) {
      throw new Error(`Scope path is a directory, expected file: ${scopePath}`);
    }

    const { content, encoding, sha } = response.data;
    if (encoding !== "base64") {
      throw new Error(`Unexpected encoding for ${scopePath}: ${encoding}`);
    }
    const decoded = Buffer.from(content, "base64").toString("utf8");
    files.push({ path: scopePath, content: decoded, sha });
  }
  return files;
}

function buildOpenAIInput(ticket, scopeFiles) {
  const ticketYaml = yaml.dump(ticket, { lineWidth: 80 });
  const fileSections = scopeFiles
    .map((file) => `Path: ${file.path}\n\n${file.content}`)
    .join("\n\n---\n\n");

  return `Ticket (YAML):\n${ticketYaml}\n\nRepository files in scope:\n${fileSections}`;
}

function validateModelFiles(modelFiles, scope) {
  if (!Array.isArray(modelFiles) || modelFiles.length === 0) {
    throw new Error("JSON response must include at least one file.");
  }
  if (modelFiles.length > MAX_FILES) {
    throw new Error(`Refusing to modify more than ${MAX_FILES} files.`);
  }

  const normalizedScope = scope.map((scopePath) =>
    scopePath.endsWith("/") ? scopePath : `${scopePath}`
  );

  return modelFiles.map((file) => {
    if (!file || typeof file.path !== "string" || typeof file.contents_base64 !== "string") {
      throw new Error("Each file entry must include 'path' and 'contents_base64'.");
    }

    const normalizedPath = path.posix.normalize(file.path.replace(/^\.\//, ""));
    if (normalizedPath.startsWith("../")) {
      throw new Error(`File path escapes repository: ${file.path}`);
    }

    const isWithinScope = normalizedScope.some((scopeEntry) => {
      if (scopeEntry.endsWith("/")) {
        return normalizedPath.startsWith(scopeEntry);
      }
      return normalizedPath === scopeEntry || normalizedPath.startsWith(`${scopeEntry}/`);
    });

    if (!isWithinScope) {
      throw new Error(`Model attempted to modify path outside scope: ${file.path}`);
    }

    let buffer;
    try {
      buffer = Buffer.from(file.contents_base64, "base64");
    } catch (error) {
      throw new Error(`Failed to decode base64 for ${file.path}: ${error.message}`);
    }

    if (!buffer.length) {
      throw new Error(`Decoded contents empty for ${file.path}.`);
    }

    if (buffer.length > MAX_FILE_SIZE) {
      throw new Error(`Decoded contents exceed ${MAX_FILE_SIZE} bytes for ${file.path}.`);
    }

    return {
      path: normalizedPath,
      contents: buffer.toString("utf8"),
      base64: file.contents_base64,
    };
  });
}

async function callOpenAI(ticket, scopeFiles) {
  const apiKey = requireEnv("OPENAI_API_KEY");
  const openai = new OpenAI({ apiKey });

  const system = [
    "You edit code for surgical tickets.",
    'Return ONLY JSON exactly: {"files":[{"path":"...","contents_base64":"..."}]}',
    "Touch ONLY files in scope. Keep edits minimal. No prose. No backticks.",
  ].join("\n");

  const user = buildOpenAIInput(ticket, scopeFiles);

  const resp = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-5-mini",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const text = resp.choices?.[0]?.message?.content?.trim() || "";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Model did not return valid JSON.");
  }

  const files = validateModelFiles(parsed.files, ticket.scope);
  return files;
}

async function ensureBranch(octokit, owner, repo, baseBranch, branchName) {
  try {
    await octokit.git.getRef({ owner, repo, ref: `heads/${branchName}` });
    throw new Error(`Branch already exists: ${branchName}`);
  } catch (error) {
    if (error.status !== 404) {
      throw error;
    }
  }

  const baseRef = await octokit.git.getRef({ owner, repo, ref: `heads/${baseBranch}` });
  await octokit.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branchName}`,
    sha: baseRef.data.object.sha,
  });
}

async function commitFiles(octokit, owner, repo, branchName, files, scopeFiles) {
  console.log("6/7 commit…");
  const shaLookup = new Map(scopeFiles.map((file) => [file.path, file.sha]));
  const message = `shipyard: ${files.map((f) => f.path).join(", ")}`;

  for (const file of files) {
    const existingSha = shaLookup.get(file.path);
    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: file.path,
      message,
      content: Buffer.from(file.contents, "utf8").toString("base64"),
      branch: branchName,
      sha: existingSha,
      committer: {
        name: "shipyard-bot",
        email: "shipyard@example.com",
      },
      author: {
        name: "shipyard-bot",
        email: "shipyard@example.com",
      },
    });
  }
}

function buildPrBody(ticket) {
  const ticketYaml = yaml.dump(ticket, { lineWidth: 80 });
  return [
    "## Ticket",
    "```yaml",
    ticketYaml.trim(),
    "```",
  ].join("\n");
}

async function openPrAndEnableAutoMerge(octokit, ticket, branchName, baseBranch, owner, repo) {
  console.log("7/7 open PR + arm auto-merge…");
  const prTitle = `shipyard: ${ticket.title}`;
  const body = buildPrBody(ticket);

  const pr = await octokit.pulls.create({
    owner,
    repo,
    title: prTitle,
    head: branchName,
    base: baseBranch,
    body,
  });

  const gql = graphql.defaults({
    headers: {
      authorization: `token ${requireEnv("GITHUB_TOKEN")}`,
    },
  });

  try {
    await gql(
      `mutation EnableAutoMerge(
        $pullRequestId: ID!
        $mergeMethod: PullRequestMergeMethod!
      ) {
        enablePullRequestAutoMerge(input: {
          pullRequestId: $pullRequestId,
          mergeMethod: $mergeMethod
        }) { clientMutationId }
      }`,
      { pullRequestId: pr.data.node_id, mergeMethod: "SQUASH" }
    );
  } catch (e) {
    console.warn(`Auto-merge not enabled: ${e.message}`);
  }

  console.log(`PR ready: ${pr.data.html_url}`);
  return pr.data.html_url;
}

async function run() {
  const argv = yargs(hideBin(process.argv))
    .option("ticket", {
      type: "string",
      describe: "Path to ticket file (Markdown or YAML)",
    })
    .help()
    .parse();

  console.log("1/7 read ticket…");
  const ticketPath = argv.ticket || DEFAULT_TICKET_PATH;
  const absoluteTicketPath = path.resolve(ticketPath);
  if (!fs.existsSync(absoluteTicketPath)) {
    throw new Error(`Ticket file not found: ${ticketPath}`);
  }

  const ticket = parseTicket(absoluteTicketPath);

  const owner = requireEnv("GITHUB_OWNER");
  const repo = requireEnv("GITHUB_REPO", "bloom");
  const baseBranch = requireEnv("GITHUB_BASE_BRANCH", "main");
  const githubToken = requireEnv("GITHUB_TOKEN");

  const octokit = new Octokit({ auth: githubToken });

  console.log("2/7 fetch scope files…");
  const scopeFiles = await fetchScopeFiles(octokit, owner, repo, baseBranch, ticket.scope);

  console.log("3/7 call OpenAI…");
  const modelFiles = await callOpenAI(ticket, scopeFiles);

  console.log("4/7 validate JSON…");

  console.log("5/7 create branch…");
  const branchName = `intent-${slugify(ticket.title)}-${nanoid(6)}`;
  await ensureBranch(octokit, owner, repo, baseBranch, branchName);

  await commitFiles(octokit, owner, repo, branchName, modelFiles, scopeFiles);

  await openPrAndEnableAutoMerge(octokit, ticket, branchName, baseBranch, owner, repo);
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  parseTicket,
  fetchScopeFiles,
  callOpenAI,
  validateModelFiles,
  run,
};
