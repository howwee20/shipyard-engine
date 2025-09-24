#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const yaml = require("js-yaml");
const { nanoid } = require("nanoid");
const OpenAI = require("openai");
const fetch = require("node-fetch");
const { Octokit } = require("@octokit/rest");
const { graphql } = require("@octokit/graphql");
const { hideBin } = require("yargs/helpers");
const yargs = require("yargs/yargs");

dotenv.config();

const DEFAULT_TICKET_PATH = "tickets/sample.md";
const MAX_FILES = 5;
const MAX_FILE_SIZE = 200 * 1024; // 200KB
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SANITY_RAILS_INVALID_CHAR_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/;
const ROOT_LAYOUT_EXPORT_ANCHORS = [
  "export default function RootLayout(",
  "export default RootLayout",
];
const NOW_PLAYING_EXPORT_ANCHORS = [
  "export default function NowPlaying",
  "export default NowPlaying",
  "export default memo(NowPlaying)",
];

const COLOR_PRESET_COLORS = ["red", "orange", "pink", "purple", "green"];
const COLOR_PRESET_KIND_SET = new Set([
  "text",
  "hover:text",
  "bg",
  "hover:bg",
  "active:bg",
  "focus-visible:ring",
]);
const COLOR_PRESET_SHADE_SET = new Set(["500", "600", "700"]);

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

function buildSystemPrompt() {
  return [
    "You edit code for surgical tickets.",
    'Return ONLY JSON exactly: {"files":[{"path":"...","contents_base64":"..."}]}',
    "Touch ONLY files in scope. Keep edits minimal. No prose. No backticks.",
  ].join("\n");
}

async function callOpenAI(ticket, scopeFiles) {
  const apiKey = requireEnv("OPENAI_API_KEY");
  const openai = new OpenAI({ apiKey });

  const system = buildSystemPrompt();

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

async function callAnthropic(ticket, scopeFiles) {
  const apiKey = requireEnv("ANTHROPIC_API_KEY");
  const baseUrl = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
  const version = process.env.ANTHROPIC_VERSION || "2023-06-01";
  const model = process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest";
  const maxTokens = Number(process.env.ANTHROPIC_MAX_TOKENS || 4000);
  const clampedTokens = Math.max(256, Math.min(maxTokens, 32000));

  const system = buildSystemPrompt();
  const user = buildOpenAIInput(ticket, scopeFiles);

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": version,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: clampedTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic request failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  const text = data?.content?.[0]?.text?.trim() || "";
  if (!text) {
    throw new Error("Anthropic response missing content.");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Model did not return valid JSON.");
  }

  const files = validateModelFiles(parsed.files, ticket.scope);
  return files;
}

async function callLLM(ticket, scopeFiles) {
  const provider = (process.env.LLM_PROVIDER || "openai").toLowerCase();
  if (provider === "anthropic") {
    return callAnthropic(ticket, scopeFiles);
  }
  if (provider === "openai") {
    return callOpenAI(ticket, scopeFiles);
  }
  throw new Error(`Unsupported LLM provider: ${provider}`);
}

function buildColorPresetReplacements(preset) {
  if (!preset || typeof preset !== "object") {
    return [];
  }

  const target = String(preset.target || "").trim();
  if (!target) {
    throw new Error("color_preset requires a 'target' color.");
  }
  if (!COLOR_PRESET_COLORS.includes(target)) {
    throw new Error(
      `color_preset target must be one of: ${COLOR_PRESET_COLORS.join(", ")}`
    );
  }

  const kinds = Array.isArray(preset.kinds) && preset.kinds.length > 0
    ? preset.kinds
    : ["text"];

  const shades = Array.isArray(preset.shades) && preset.shades.length > 0
    ? preset.shades
    : [500];

  const replacements = [];

  for (const rawKind of kinds) {
    const kind = String(rawKind || "").trim();
    if (!COLOR_PRESET_KIND_SET.has(kind)) {
      throw new Error(
        `color_preset kind must be one of: ${Array.from(
          COLOR_PRESET_KIND_SET
        ).join(", ")}`
      );
    }

    for (const rawShade of shades) {
      const shade = String(rawShade || "").trim();
      if (!COLOR_PRESET_SHADE_SET.has(shade)) {
        throw new Error(
          `color_preset shades must be within: ${Array.from(
            COLOR_PRESET_SHADE_SET
          ).join(", ")}`
        );
      }

      const find_any = Array.from(
        new Set(
          COLOR_PRESET_COLORS.map(
            (color) => `${kind}-${color}-${shade}`
          )
        )
      );
      const replace = `${kind}-${target}-${shade}`;
      replacements.push({ find_any, replace });
    }
  }

  return replacements;
}

function applyColorPresets(replacements) {
  return replacements.map((entry) => {
    if (!entry || typeof entry !== "object") {
      return entry;
    }

    if (
      Array.isArray(entry.replacements) &&
      entry.replacements.length > 0
    ) {
      return entry;
    }

    if (!entry.color_preset) {
      return entry;
    }

    const generated = buildColorPresetReplacements(entry.color_preset);
    if (!generated.length) {
      return entry;
    }

    return { ...entry, replacements: generated };
  });
}

function safeReplace(ticket, scopeFiles) {
  const replacements = Array.isArray(ticket.safe_replace)
    ? ticket.safe_replace
    : [];

  if (replacements.length === 0) {
    throw new Error("SafeReplace requires at least one replacement entry.");
  }

  const expandedReplacements = applyColorPresets(replacements);

  const scopeMap = new Map(
    scopeFiles.map((file) => [path.posix.normalize(file.path), file])
  );

  const normalizedScope = ticket.scope.map((scopePath) =>
    scopePath.endsWith("/") ? scopePath : `${scopePath}`
  );

  const files = [];

  for (const entry of expandedReplacements) {
    if (!entry || typeof entry.path !== "string") {
      throw new Error("SafeReplace entries require a 'path' string.");
    }

    const normalizedPath = path.posix.normalize(entry.path.replace(/^\.\//, ""));
    if (normalizedPath.startsWith("../")) {
      throw new Error(`SafeReplace path escapes repository: ${entry.path}`);
    }

    const isWithinScope = normalizedScope.some((scopeEntry) => {
      if (scopeEntry.endsWith("/")) {
        return normalizedPath.startsWith(scopeEntry);
      }
      return (
        normalizedPath === scopeEntry || normalizedPath.startsWith(`${scopeEntry}/`)
      );
    });

    if (!isWithinScope) {
      throw new Error(`SafeReplace path outside scope: ${entry.path}`);
    }

    const scopeFile = scopeMap.get(normalizedPath);
    if (!scopeFile) {
      throw new Error(`SafeReplace path not found in scope files: ${entry.path}`);
    }

    if (!Array.isArray(entry.replacements) || entry.replacements.length === 0) {
      continue;
    }

    const originalContent = scopeFile.content;
    let content = originalContent;
    let modified = false;
    let replacementCount = 0;
    const searchedTokens = new Set();

    for (const replacement of entry.replacements) {
      if (!replacement || typeof replacement !== "object") {
        throw new Error(
          "SafeReplace replacements require a replacement object."
        );
      }

      const replaceValue = replacement.replace;
      if (typeof replaceValue !== "string") {
        throw new Error(
          "SafeReplace replacements require a 'replace' string."
        );
      }

      if (typeof replacement.find === "string") {
        searchedTokens.add(replacement.find);
        const segments = content.split(replacement.find);
        if (segments.length === 1) {
          console.log(
            `SafeReplace: token not found ${replacement.find} in ${normalizedPath}`
          );
          continue;
        }

        const occurrences = segments.length - 1;
        content = segments.join(replaceValue);
        if (occurrences > 0) {
          modified = true;
          replacementCount += occurrences;
        }
        continue;
      }

      if (Array.isArray(replacement.find_any)) {
        const tokenList = replacement.find_any
          .map((token) => String(token || "").trim())
          .filter((token) => token.length > 0);

        if (tokenList.length === 0) {
          throw new Error(
            "SafeReplace replacements require non-empty 'find_any' strings."
          );
        }

        for (const token of tokenList) {
          searchedTokens.add(token);
        }

        let chosenToken = null;
        let chosenIndex = Infinity;
        for (const token of tokenList) {
          const index = content.indexOf(token);
          if (index !== -1 && index < chosenIndex) {
            chosenToken = token;
            chosenIndex = index;
          }
        }

        if (!chosenToken) {
          console.log(
            `SafeReplace: token not found (any of ${tokenList.join(", ")}) in ${normalizedPath}`
          );
          continue;
        }

        const segments = content.split(chosenToken);
        const occurrences = segments.length - 1;
        content = segments.join(replaceValue);
        if (occurrences > 0) {
          modified = true;
          replacementCount += occurrences;
        }
        continue;
      }

      throw new Error(
        "SafeReplace replacements require either 'find' or 'find_any'."
      );
    }

    if (modified && content !== originalContent) {
      console.log(
        `SafeReplace: replaced ${replacementCount} token(s) in ${normalizedPath}`
      );
      files.push({
        path: normalizedPath,
        contents_base64: Buffer.from(content, "utf8").toString("base64"),
      });
    } else {
      const tokenSummary = Array.from(searchedTokens);
      if (tokenSummary.length > 0) {
        console.log(
          `SafeReplace: no changes in ${normalizedPath}. Searched: ${tokenSummary.join(", ")}`
        );
      } else {
        console.log(
          `SafeReplace: no changes in ${normalizedPath}. Searched: (none)`
        );
      }
    }
  }

  if (files.length === 0) {
    return [];
  }

  return validateModelFiles(files, ticket.scope);
}

function runSanityRails(files) {
  for (const file of files) {
    const text = file.contents;
    const pathName = file.path;

    const size = Buffer.byteLength(text, "utf8");
    if (!size || size > 200000) {
      console.error(
        `SanityRails: ${pathName} failed size check (${size} bytes)`
      );
      throw new Error("SanityRails failure");
    }

    if (SANITY_RAILS_INVALID_CHAR_REGEX.test(text)) {
      console.error(
        `SanityRails: ${pathName} failed non-printable character check`
      );
      throw new Error("SanityRails failure");
    }

    if (
      pathName.endsWith("src/app/layout.tsx") &&
      !ROOT_LAYOUT_EXPORT_ANCHORS.some((anchor) => text.includes(anchor))
    ) {
      console.error(
        `SanityRails: ${pathName} failed RootLayout export assertion`
      );
      throw new Error("SanityRails failure");
    }

    if (
      pathName.endsWith("src/app/components/NowPlaying.tsx") &&
      !NOW_PLAYING_EXPORT_ANCHORS.some((anchor) => text.includes(anchor))
    ) {
      console.error(
        `SanityRails: ${pathName} failed NowPlaying export assertion`
      );
      throw new Error("SanityRails failure");
    }
  }
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

  let autoMergeEnabled = true;
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
    autoMergeEnabled = false;
  }

  console.log(`PR ready: ${pr.data.html_url}`);
  return {
    url: pr.data.html_url,
    number: pr.data.number,
    headSha: pr.data.head.sha,
    autoMergeEnabled,
  };
}

async function waitForCheck(octokit, owner, repo, sha, options = {}) {
  const { nameSubstr = "Vercel", timeoutMs = 900000, intervalMs = 5000 } = options;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const response = await octokit.checks.listForRef({
      owner,
      repo,
      ref: sha,
      per_page: 100,
    });
    const checkRuns = response.data.check_runs || [];
    const match = checkRuns.find((run) => run.name && run.name.includes(nameSubstr));

    if (match) {
      if (match.status === "completed") {
        return match;
      }
    }

    await delay(intervalMs);
  }

  return null;
}

async function mergePr(octokit, owner, repo, number) {
  await octokit.pulls.merge({
    owner,
    repo,
    pull_number: number,
    merge_method: "squash",
  });
}

async function commentPr(octokit, owner, repo, number, body) {
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: number,
    body,
  });
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

  let modelFiles;
  if (Array.isArray(ticket.safe_replace) && ticket.safe_replace.length > 0) {
    console.log("3/7 safe replace…");
    modelFiles = safeReplace(ticket, scopeFiles);
    if (modelFiles.length === 0) {
      console.log("SafeReplace: no files modified; exiting early.");
      return;
    }
  } else {
    console.log("3/7 call LLM…");
    modelFiles = await callLLM(ticket, scopeFiles);
  }

  const verifyStrict =
    (process.env.VERIFY_STRICT || "true").toLowerCase() !== "false";
  if (verifyStrict) {
    console.log("4/7 run sanity rails…");
    runSanityRails(modelFiles);
  } else {
    console.log("4/7 run sanity rails… (skipped, VERIFY_STRICT=false)");
  }

  console.log("5/7 create branch…");
  const branchName = `intent-${slugify(ticket.title)}-${nanoid(6)}`;
  await ensureBranch(octokit, owner, repo, baseBranch, branchName);

  await commitFiles(octokit, owner, repo, branchName, modelFiles, scopeFiles);

  const prInfo = await openPrAndEnableAutoMerge(
    octokit,
    ticket,
    branchName,
    baseBranch,
    owner,
    repo
  );

  const useScriptedMerge =
    (process.env.USE_SCRIPTED_MERGE || "").toLowerCase() === "true";

  if (useScriptedMerge || !prInfo.autoMergeEnabled) {
    console.log("Scripted merge fallback: waiting for required check…");
    const checkNameSubstr = "Vercel";
    try {
      const check = await waitForCheck(
        octokit,
        owner,
        repo,
        prInfo.headSha,
        { nameSubstr: checkNameSubstr }
      );
      const conclusion = check?.conclusion || "timeout";

      if (conclusion === "success") {
        console.log("Scripted merge fallback: check succeeded, merging PR…");
        await mergePr(octokit, owner, repo, prInfo.number);
        console.log("Scripted merge fallback: PR merged via scripted flow.");
      } else {
        const checkName = check?.name || checkNameSubstr;
        console.log(
          `Scripted merge fallback: check concluded '${conclusion}', commenting.`
        );
        await commentPr(
          octokit,
          owner,
          repo,
          prInfo.number,
          `Shipyard: required check '${checkName}' concluded: ${conclusion}. Not merging.`
        );
      }
    } catch (error) {
      console.warn(`Scripted merge fallback error: ${error.message}`);
    }
  }
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
  callAnthropic,
  callLLM,
  safeReplace,
  validateModelFiles,
  runSanityRails,
  waitForCheck,
  mergePr,
  commentPr,
  run,
};
