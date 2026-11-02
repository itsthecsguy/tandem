// Opens an issue when something Tandem pins moves: Kinesis's config, its ZMK,
// that ZMK's Zephyr, or the Docker image they build in. See shared/pins.json.
// Nothing reaches users until a release moves the pin. The issue says it's time
// to test one. Runs daily from .github/workflows/upstream.yml. With DRY_RUN set
// it only prints what it found, and needs no token with write access.

import { readFileSync } from "node:fs";

const pins = JSON.parse(readFileSync(new URL("../shared/pins.json", import.meta.url), "utf8"));
const repo = process.env.GITHUB_REPOSITORY ?? "itsthecsguy/tandem";
const dryRun = !!process.env.DRY_RUN;
const LABEL = "upstream";

async function github(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const NAMES = { kinesis: "Kinesis's config", zmk: "Kinesis's ZMK", zephyr: "ZMK's Zephyr", beta: "The ZMK 4.1 port" };

const STEPS = `To take it:

- [ ] Read the changes for anything that needs Tandem to change.
- [ ] Move the pin in \`shared/pins.json\`, and update \`template/\` to match. The Firmware workflow builds it on push.
- [ ] Flash it to a keyboard. Check typing, Bluetooth reconnecting and an update with no key presses.
- [ ] Add a release to \`version.txt\` and \`shared/changelog.ts\`, then run \`npm run release\`.`;

async function movedBranches() {
  const found = [];
  for (const key of Object.keys(NAMES)) {
    const pin = pins[key];
    const ref = await github("GET", `/repos/${pin.repo}/git/ref/heads/${encodeURIComponent(pin.branch)}`);
    const head = ref.object.sha;
    if (head === pin.sha) continue;
    const compare = await github("GET", `/repos/${pin.repo}/compare/${pin.sha}...${head}`);
    const commits = compare.commits.map((c) => `- [\`${c.sha.slice(0, 7)}\`](${c.html_url}) ${c.commit.message.split("\n")[0]}`);
    found.push({
      title: `${NAMES[key]} moved to ${head.slice(0, 7)}`,
      body: `\`${pin.repo}\` branch \`${pin.branch}\` is ${compare.ahead_by} commit(s) ahead of the pin, \`${pin.sha.slice(0, 7)}\`. [Compare](${compare.html_url}).\n\n${commits.join("\n")}\n\n${STEPS}`,
    });
  }
  return found;
}

async function movedImage() {
  const { name, tag, digest } = pins.image;
  const res = await fetch(`https://hub.docker.com/v2/repositories/${name}/tags/${tag}`);
  if (!res.ok) throw new Error(`Docker Hub: ${res.status}`);
  const latest = (await res.json()).digest;
  if (latest === digest) return [];
  return [
    {
      title: `The build image moved to ${latest.slice(0, 19)}`,
      body: `\`${name}:${tag}\` is now \`${latest}\`. The pin is \`${digest}\`.\n\n${STEPS.replace("Read the changes for anything that needs Tandem to change.", "Check what changed in the image, especially its Zephyr SDK.")}`,
    },
  ];
}

const moved = [...(await movedBranches()), ...(await movedImage())];
if (dryRun) {
  console.log(moved.length ? moved.map((m) => `${m.title}\n${m.body}\n`).join("\n") : "Nothing moved.");
  process.exit(0);
}

await github("POST", `/repos/${repo}/labels`, { name: LABEL, color: "c5def5", description: "Something Tandem pins moved" }).catch(() => {});
const open = await github("GET", `/repos/${repo}/issues?labels=${LABEL}&state=open&per_page=100`);
for (const { title, body } of moved) {
  const existing = open.find((issue) => issue.title === title);
  if (existing) continue;
  const issue = await github("POST", `/repos/${repo}/issues`, { title, body, labels: [LABEL] });
  console.log(`Opened ${issue.html_url}`);
}
if (!moved.length) console.log("Nothing moved.");
