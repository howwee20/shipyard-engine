#!/usr/bin/env node

const dotenv = require("dotenv");
const { nanoid } = require("nanoid");
const OpenAI = require("openai");
const { Octokit } = require("@octokit/rest");
const { graphql } = require("@octokit/graphql");

dotenv.config();

const SAMPLE_INTENT = "Change header brand color to purple";
const ALLOWED_DIRECTORIES = ["src/", "app/", "pages/", "styles/"];
const MAX_FILES = 5;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function slugifyIntent(intent) {
  return intent
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 40) || "intent";
}

function validateFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("Model did not return any files to change.");
  }
  if (files.length > MAX_FILES) {
    throw new Error(`Too many files returned (>${MAX_FILES}). Aborting.`);
  }

  for (const file of files) {
    if (!file || typeof file.path !== "string") {
      throw new Error("Invalid file entry returned by model.");
    }
    const normalizedPath = file.path.replace(/\\/g, "/");
    const isAllowed = ALLOWED_DIRECTORIES.some((dir) =>
      normalizedPath.startsWith(dir)
    );
    if (!isAllowed) {
      throw new Error(
        `File path '${file.path}' is outside allowed directories (${ALLOWED_DIRECTORIES.join(", ")}).`
      );
    }
  }
}

async function getCodeFromAI(intent) {
  console.log("1/5 OpenAI: generating patch");
  const client = new OpenAI({ apiKey: requireEnv("OPENAI_API_KEY") });

  const systemInstruction =
    "Return ONLY a JSON object with 'files' array of {path, contents_base64} representing the minimal set of changed files to fulfill the intent. No backticks, no prose.";

  const userInstruction = `Repository context:\n- Primary UI entry: src/app/layout.tsx\n- Styling: styles/*.css\n- Use minimal diff, least-touch approach.\n\nIntent:\n${intent}`;

  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    input: [
      {
        role: "system",
        content: [{ type: "text", text: systemInstruction }],
      },
      {
        role: "user",
        content: [{ type: "text", text: userInstruction }],
      },
    ],
    temperature: 0.2,
  });

  const outputText =
    response?.output?.[0]?.content?.[0]?.text || response?.output_text;

  if (!outputText) {
    throw new Error("OpenAI response did not include any text output.");
  }

  let payload;
  try {
    payload = JSON.parse(outputText.trim());
  } catch (error) {
    throw new Error(`Failed to parse OpenAI JSON response: ${error.message}`);
  }

  if (!payload || !Array.isArray(payload.files)) {
    throw new Error("OpenAI response missing 'files' array.");
  }

  validateFiles(payload.files);

  const files = payload.files.map((file) => {
    const buffer = Buffer.from(file.contents_base64, "base64");
    if (!buffer.length) {
      throw new Error(`File '${file.path}' decoded to empty contents.`);
    }
    return {
      path: file.path.replace(/\\/g, "/"),
      contents: buffer,
    };
  });

  return { files };
}

async function createPRWithAutoMerge({ intent, files }) {
  const owner = requireEnv("GITHUB_OWNER");
  const repo = requireEnv("GITHUB_REPO");
  const baseBranch = requireEnv("GITHUB_BASE_BRANCH");
  const token = requireEnv("GITHUB_TOKEN");

  if (!files.length) {
    throw new Error("No files provided for PR.");
  }

  console.log("2/5 GitHub: creating branch …");
  const octokit = new Octokit({ auth: token });

  const baseRef = await octokit.git.getRef({
    owner,
    repo,
    ref: `heads/${baseBranch}`,
  });

  const baseSha = baseRef.data.object.sha;

  const baseCommit = await octokit.git.getCommit({
    owner,
    repo,
    commit_sha: baseSha,
  });

  const baseTreeSha = baseCommit.data.tree.sha;

  const intentSlug = slugifyIntent(intent);
  const branchName = `intent-${intentSlug}-${nanoid(6)}`;

  await octokit.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branchName}`,
    sha: baseSha,
  });

  console.log("3/5 GitHub: creating tree/commit …");

  const blobs = await Promise.all(
    files.map((file) =>
      octokit.git.createBlob({
        owner,
        repo,
        content: file.contents.toString("base64"),
        encoding: "base64",
      })
    )
  );

  const treeItems = files.map((file, index) => ({
    path: file.path,
    mode: "100644",
    type: "blob",
    sha: blobs[index].data.sha,
  }));

  const newTree = await octokit.git.createTree({
    owner,
    repo,
    base_tree: baseTreeSha,
    tree: treeItems,
  });

  const commit = await octokit.git.createCommit({
    owner,
    repo,
    message: `shipyard: ${intentSlug}`,
    tree: newTree.data.sha,
    parents: [baseSha],
  });

  await octokit.git.updateRef({
    owner,
    repo,
    ref: `heads/${branchName}`,
    sha: commit.data.sha,
    force: false,
  });

  console.log("4/5 GitHub: opening PR …");

  const prTitle = `shipyard: ${intentSlug}`;
  const prBody = `Intent:\n\n${intent}`;

  const pullRequest = await octokit.pulls.create({
    owner,
    repo,
    title: prTitle,
    head: branchName,
    base: baseBranch,
    body: prBody,
  });

  await octokit.issues.addLabels({
    owner,
    repo,
    issue_number: pullRequest.data.number,
    labels: ["shipyard-automerge"],
  });

  console.log("5/5 GitHub: enabling auto-merge …");

  const gql = graphql.defaults({
    headers: {
      authorization: `token ${token}`,
    },
  });

  await gql(
    `mutation EnableAutoMerge($pullRequestId: ID!, $method: PullRequestMergeMethod!) {
      enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $method }) {
        clientMutationId
      }
    }`,
    {
      pullRequestId: pullRequest.data.node_id,
      method: "SQUASH",
    }
  );

  console.log(`PR ready: ${pullRequest.data.html_url}`);
  console.log("Auto-merge enabled; waiting on checks.");

  return pullRequest.data.html_url;
}

async function runIntent(intent) {
  try {
    const owner = requireEnv("GITHUB_OWNER");
    const repo = requireEnv("GITHUB_REPO");
    if (!intent || typeof intent !== "string") {
      throw new Error("Intent must be a non-empty string.");
    }

    console.log(`Running intent for ${owner}/${repo}`);

    const { files } = await getCodeFromAI(intent);

    const prUrl = await createPRWithAutoMerge({ intent, files });

    console.log(`Completed. PR URL: ${prUrl}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  const intentFromArgs = process.argv.slice(2).join(" ");
  const intent = intentFromArgs || SAMPLE_INTENT;
  runIntent(intent);
}

module.exports = {
  getCodeFromAI,
  createPRWithAutoMerge,
  runIntent,
};
