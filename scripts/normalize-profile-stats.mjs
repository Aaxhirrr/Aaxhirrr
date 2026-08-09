import { readFile, writeFile } from "node:fs/promises";

const token = process.env.PROFILE_STATS_TOKEN;
const username = process.env.PROFILE_STATS_USERNAME ?? "Aaxhirrr";
const statsPath = "profile/stats.svg";

if (!token) {
  throw new Error("PROFILE_STATS_TOKEN is required");
}

const query = `
  query ProfileStats($login: String!) {
    user(login: $login) {
      pullRequests {
        totalCount
      }
      mergedPullRequests: pullRequests(states: MERGED) {
        totalCount
      }
      repositories(
        ownerAffiliations: [OWNER, ORGANIZATION_MEMBER, COLLABORATOR]
      ) {
        totalCount
      }
    }
  }
`;

const response = await fetch("https://api.github.com/graphql", {
  method: "POST",
  headers: {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "Aaxhirrr-profile-stats",
  },
  body: JSON.stringify({ query, variables: { login: username } }),
});

if (!response.ok) {
  throw new Error(`GitHub GraphQL request failed with HTTP ${response.status}`);
}

const payload = await response.json();
if (payload.errors?.length) {
  throw new Error(`GitHub GraphQL request failed: ${payload.errors[0].message}`);
}

const profile = payload.data?.user;
if (!profile) {
  throw new Error(`GitHub user ${username} was not found`);
}

let svg = await readFile(statsPath, "utf8");

const readCardValue = (id) => {
  const match = svg.match(
    new RegExp(`<text[^>]*data-testid=["']${id}["'][^>]*>([^<]*)</text>`),
  );
  if (!match) {
    throw new Error(`Generated card is missing the ${id} statistic`);
  }
  return Number(match[1].trim().replaceAll(",", ""));
};

const replaceCardValue = (id, value) => {
  const pattern = new RegExp(
    `(<text[^>]*data-testid=["']${id}["'][^>]*>)[^<]*(</text>)`,
  );
  if (!pattern.test(svg)) {
    throw new Error(`Generated card is missing the ${id} statistic`);
  }
  svg = svg.replace(pattern, `$1${value}$2`);
};

const totalPullRequests = profile.pullRequests.totalCount;
const mergedPullRequests = profile.mergedPullRequests.totalCount;
const allRepositories = profile.repositories.totalCount;

if (readCardValue("prs") !== totalPullRequests) {
  throw new Error("Generated card did not include all authenticated pull requests");
}
if (readCardValue("prs_merged") !== mergedPullRequests) {
  throw new Error("Generated card did not include all authenticated merged pull requests");
}

replaceCardValue("contribs", allRepositories);
svg = svg.replaceAll(/Contributed to(?: \(last year\))?:/g, "All Repositories:");
svg = svg.replaceAll(
  /All Repositories: [\d,]+/g,
  `All Repositories: ${allRepositories}`,
);

if (!svg.includes(`All Repositories: ${allRepositories}</desc>`)) {
  throw new Error("Generated card accessibility text has the wrong repository total");
}

await writeFile(statsPath, svg);
console.log(
  `Verified ${totalPullRequests} PRs, ${mergedPullRequests} merged PRs, and ${allRepositories} accessible repositories.`,
);
