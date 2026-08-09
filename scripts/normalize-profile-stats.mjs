import { writeFile } from "node:fs/promises";

const token = process.env.PROFILE_STATS_TOKEN;
const username = process.env.PROFILE_STATS_USERNAME ?? "Aaxhirrr";
const statsPath = "profile/cool-stats.svg";
const displayedGrade = "A++";
const now = process.env.PROFILE_STATS_NOW
  ? new Date(process.env.PROFILE_STATS_NOW)
  : new Date();

if (!token) {
  throw new Error("PROFILE_STATS_TOKEN is required");
}
if (Number.isNaN(now.getTime())) {
  throw new Error("PROFILE_STATS_NOW must be a valid date when provided");
}

const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  "User-Agent": "Aaxhirrr-profile-stats",
  "X-GitHub-Api-Version": "2022-11-28",
};

const requestJson = async (url, options = {}) => {
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    throw new Error(`GitHub request failed with HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(`GitHub GraphQL request failed: ${payload.errors[0].message}`);
  }
  return payload;
};

const graphql = async (query, variables) =>
  requestJson("https://api.github.com/graphql", {
    method: "POST",
    body: JSON.stringify({ query, variables }),
  });

const profileQuery = `
  query ProfileStats($login: String!, $cursor: String) {
    user(login: $login) {
      name
      login
      createdAt
      location
      pullRequests {
        totalCount
      }
      mergedPullRequests: pullRequests(states: MERGED) {
        totalCount
      }
      repositories(
        first: 100
        after: $cursor
        ownerAffiliations: [OWNER, ORGANIZATION_MEMBER, COLLABORATOR]
      ) {
        totalCount
        nodes {
          isPrivate
          stargazerCount
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

let repositoryCursor = null;
let profile = null;
const repositories = [];

do {
  const payload = await graphql(profileQuery, {
    login: username,
    cursor: repositoryCursor,
  });
  const user = payload.data?.user;
  if (!user) {
    throw new Error(`GitHub user ${username} was not found`);
  }

  profile ??= user;
  repositories.push(...user.repositories.nodes);
  repositoryCursor = user.repositories.pageInfo.hasNextPage
    ? user.repositories.pageInfo.endCursor
    : null;
} while (repositoryCursor);

const contributionQuery = `
  query ContributionYear($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar {
          weeks {
            contributionDays {
              date
              contributionCount
            }
          }
        }
      }
    }
  }
`;

const pullRequestLinesQuery = `
  query PullRequestLines($login: String!, $cursor: String) {
    user(login: $login) {
      pullRequests(first: 100, after: $cursor) {
        nodes {
          additions
          deletions
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

const fetchPullRequestLines = async () => {
  let cursor = null;
  let linesChanged = 0;

  do {
    const payload = await graphql(pullRequestLinesQuery, {
      login: username,
      cursor,
    });
    const pullRequests = payload.data.user.pullRequests;
    linesChanged += pullRequests.nodes.reduce(
      (sum, pullRequest) => sum + pullRequest.additions + pullRequest.deletions,
      0,
    );
    cursor = pullRequests.pageInfo.hasNextPage
      ? pullRequests.pageInfo.endCursor
      : null;
  } while (cursor);

  return linesChanged;
};

const createdAt = new Date(profile.createdAt);
const firstYear = createdAt.getUTCFullYear();
const currentYear = now.getUTCFullYear();
const currentDate = now.toISOString().slice(0, 10);
const years = Array.from(
  { length: currentYear - firstYear + 1 },
  (_, index) => firstYear + index,
);

const contributionYearsPromise = Promise.all(
  years.map(async (year) => {
    const to =
      year === currentYear
        ? now.toISOString()
        : `${year}-12-31T23:59:59Z`;
    const payload = await graphql(contributionQuery, {
      login: username,
      from: `${year}-01-01T00:00:00Z`,
      to,
    });
    return payload.data.user.contributionsCollection.contributionCalendar.weeks
      .flatMap((week) => week.contributionDays)
      .filter((day) => day.date.startsWith(String(year)))
      .filter((day) => day.date <= currentDate);
  }),
);

const pullRequestLinesPromise = fetchPullRequestLines();

const [contributionYears, totalLinesChanged] = await Promise.all([
  contributionYearsPromise,
  pullRequestLinesPromise,
]);

const contributionsByDate = new Map();
for (const day of contributionYears.flat()) {
  contributionsByDate.set(day.date, day.contributionCount);
}

const contributionDays = [...contributionsByDate.entries()]
  .map(([date, count]) => ({ date, count }))
  .sort((left, right) => left.date.localeCompare(right.date));

const totalContributions = contributionDays.reduce(
  (sum, day) => sum + day.count,
  0,
);

const dayMs = 24 * 60 * 60 * 1000;
const parseDate = (date) => new Date(`${date}T00:00:00Z`);
const dateKey = (date) => date.toISOString().slice(0, 10);

const calculateStreaks = (days) => {
  let longest = { count: 0, start: null, end: null };
  let runStart = null;
  let runCount = 0;

  for (const day of days) {
    if (day.count > 0) {
      runStart ??= day.date;
      runCount += 1;
      if (runCount > longest.count) {
        longest = { count: runCount, start: runStart, end: day.date };
      }
    } else {
      runStart = null;
      runCount = 0;
    }
  }

  let endIndex = days.findIndex((day) => day.date === currentDate);
  if (endIndex < 0) {
    endIndex = days.length - 1;
  }
  if (days[endIndex]?.count === 0) {
    endIndex -= 1;
  }

  const lastActiveDate = days[endIndex]?.date;
  const daysSinceLastActivity = lastActiveDate
    ? Math.round((parseDate(currentDate) - parseDate(lastActiveDate)) / dayMs)
    : Number.POSITIVE_INFINITY;

  if (daysSinceLastActivity > 1 || endIndex < 0) {
    return { current: { count: 0, start: null, end: null }, longest };
  }

  let startIndex = endIndex;
  while (startIndex >= 0 && days[startIndex].count > 0) {
    startIndex -= 1;
  }

  return {
    current: {
      count: endIndex - startIndex,
      start: days[startIndex + 1].date,
      end: days[endIndex].date,
    },
    longest,
  };
};

const streaks = calculateStreaks(contributionDays);
const allRepositories = profile.repositories.totalCount;
const privateRepositories = repositories.filter((repo) => repo.isPrivate).length;
const publicRepositories = allRepositories - privateRepositories;
const totalStars = repositories.reduce(
  (sum, repository) => sum + repository.stargazerCount,
  0,
);
const totalPullRequests = profile.pullRequests.totalCount;
const mergedPullRequests = profile.mergedPullRequests.totalCount;

const chartDayCount = 52 * 7;
const today = parseDate(currentDate);
const chartStart = new Date(today.getTime() - (chartDayCount - 1) * dayMs);
const weeklyContributions = Array.from({ length: 52 }, () => 0);

for (let index = 0; index < chartDayCount; index += 1) {
  const date = new Date(chartStart.getTime() + index * dayMs);
  weeklyContributions[Math.floor(index / 7)] +=
    contributionsByDate.get(dateKey(date)) ?? 0;
}

const chart = { left: 56, top: 532, width: 988, height: 92 };
const chartBottom = chart.top + chart.height;
const chartMaximum = Math.max(...weeklyContributions, 1);
const chartPoints = weeklyContributions.map((value, index) => {
  const x = chart.left + (index / (weeklyContributions.length - 1)) * chart.width;
  const y = chartBottom - (value / chartMaximum) * chart.height;
  return { x, y };
});
const linePath = chartPoints
  .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
  .join(" ");
const areaPath = `${linePath} L${chart.left + chart.width} ${chartBottom} L${chart.left} ${chartBottom} Z`;
const chartLabelIndexes = [0, 10, 20, 30, 40, 51];

const escapeXml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const formatNumber = (value) => new Intl.NumberFormat("en-US").format(value);
const formatCompactNumber = (value) =>
  new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
const formatDate = (value) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(parseDate(value));
const formatDateRange = (streak) =>
  streak.start && streak.end
    ? `${formatDate(streak.start)} – ${formatDate(streak.end)}`
    : "No active streak";
const joinedDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
}).format(createdAt);
const updatedDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
}).format(now);

const renderMetric = ({ x, y, label, value, id }) => `
  <g transform="translate(${x} ${y})">
    <text class="metric-value" data-testid="${id}">${escapeXml(value)}</text>
    <text class="metric-label" y="28">${escapeXml(label)}</text>
  </g>`;

const metrics = [
  { x: 56, y: 155, label: "TOTAL STARS", value: formatNumber(totalStars), id: "stars" },
  { x: 238, y: 155, label: "TOTAL PRS", value: formatNumber(totalPullRequests), id: "prs" },
  { x: 420, y: 155, label: "PRS MERGED", value: formatNumber(mergedPullRequests), id: "prs_merged" },
  { x: 56, y: 248, label: "ALL REPOSITORIES", value: formatNumber(allRepositories), id: "repos" },
  { x: 302, y: 248, label: "PR LINES CHANGED", value: formatCompactNumber(totalLinesChanged), id: "lines_changed" },
];

const chartLabels = chartLabelIndexes
  .map((index) => {
    const date = new Date(chartStart.getTime() + index * 7 * dayMs);
    const x = chart.left + (index / 51) * chart.width;
    const label = new Intl.DateTimeFormat("en-US", {
      month: "short",
      timeZone: "UTC",
    }).format(date);
    return `<text class="chart-label" x="${x.toFixed(1)}" y="648" text-anchor="middle">${label}</text>`;
  })
  .join("\n");

const titleName = profile.name || profile.login;
const description = [
  `Grade ${displayedGrade}`,
  `${formatNumber(totalPullRequests)} pull requests`,
  `${formatNumber(mergedPullRequests)} merged pull requests`,
  `${formatNumber(allRepositories)} repositories`,
  `${formatNumber(totalLinesChanged)} lines changed across authored pull requests`,
  `${formatNumber(totalContributions)} contributions`,
  `${streaks.current.count} day current streak`,
  `${streaks.longest.count} day longest streak`,
].join(", ");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="700" viewBox="0 0 1100 700" role="img" aria-labelledby="titleId descId">
  <title id="titleId">${escapeXml(titleName)}&apos;s Stats, Grade ${displayedGrade}</title>
  <desc id="descId">${escapeXml(description)}</desc>
  <defs>
    <linearGradient id="activity-fill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#bf91f3" stop-opacity="0.72"/>
      <stop offset="100%" stop-color="#bf91f3" stop-opacity="0.04"/>
    </linearGradient>
  </defs>
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif; }
    .title { fill: #70a5fd; font-size: 29px; font-weight: 700; letter-spacing: -0.4px; }
    .eyebrow { fill: #8b949e; font-family: "SFMono-Regular", Consolas, monospace; font-size: 12px; font-weight: 600; letter-spacing: 1.4px; }
    .metric-value { fill: #f0f6fc; font-size: 34px; font-weight: 720; letter-spacing: -0.6px; }
    .metric-label { fill: #38bdae; font-family: "SFMono-Regular", Consolas, monospace; font-size: 12px; font-weight: 650; letter-spacing: 0.8px; }
    .grade { fill: #38bdae; font-size: 42px; font-weight: 800; letter-spacing: -1px; }
    .streak-value { fill: #70a5fd; font-size: 36px; font-weight: 760; letter-spacing: -0.6px; }
    .streak-label { fill: #f0f6fc; font-size: 15px; font-weight: 650; }
    .streak-date { fill: #38bdae; font-family: "SFMono-Regular", Consolas, monospace; font-size: 12px; }
    .chart-label { fill: #8b949e; font-family: "SFMono-Regular", Consolas, monospace; font-size: 11px; }
    .footer { fill: #8b949e; font-family: "SFMono-Regular", Consolas, monospace; font-size: 11px; }
  </style>

  <rect x="0.5" y="0.5" width="1099" height="699" rx="18" fill="#161822" stroke="#2d333b"/>

  <text class="title" x="56" y="58">Stats</text>
  <text class="eyebrow" x="56" y="86">PUBLIC + PRIVATE GITHUB ACTIVITY</text>
  <text class="eyebrow" x="1044" y="58" text-anchor="end">UPDATED ${escapeXml(updatedDate.toUpperCase())}</text>

  ${metrics.map(renderMetric).join("\n")}

  <g transform="translate(920 206)">
    <circle r="71" fill="none" stroke="#2e3855" stroke-width="12"/>
    <circle r="71" fill="none" stroke="#70a5fd" stroke-width="12" stroke-linecap="round"/>
    <text class="grade" data-testid="grade" text-anchor="middle" dominant-baseline="central">${displayedGrade}</text>
    <text class="eyebrow" y="103" text-anchor="middle">GRADE</text>
  </g>

  <line x1="56" y1="327" x2="1044" y2="327" stroke="#2d333b"/>

  <g transform="translate(56 381)">
    <text class="streak-value" data-testid="total_contributions">${formatNumber(totalContributions)}</text>
    <text class="streak-label" y="30">Total contributions</text>
    <text class="streak-date" y="55">Since ${escapeXml(joinedDate)}</text>
  </g>
  <g transform="translate(403 381)">
    <text class="streak-value" data-testid="current_streak">${streaks.current.count} days</text>
    <text class="streak-label" y="30">Current streak</text>
    <text class="streak-date" y="55">${escapeXml(formatDateRange(streaks.current))}</text>
  </g>
  <g transform="translate(748 381)">
    <text class="streak-value" data-testid="longest_streak">${streaks.longest.count} days</text>
    <text class="streak-label" y="30">Longest streak</text>
    <text class="streak-date" y="55">${escapeXml(formatDateRange(streaks.longest))}</text>
  </g>

  <line x1="56" y1="470" x2="1044" y2="470" stroke="#2d333b"/>
  <text class="eyebrow" x="56" y="509">CONTRIBUTION VELOCITY · LAST 12 MONTHS</text>
  <text class="eyebrow" x="1044" y="509" text-anchor="end">PEAK ${formatNumber(chartMaximum)} / WEEK</text>
  <line x1="${chart.left}" y1="${chartBottom}" x2="${chart.left + chart.width}" y2="${chartBottom}" stroke="#2d333b"/>
  <path d="${areaPath}" fill="url(#activity-fill)"/>
  <path d="${linePath}" fill="none" stroke="#bf91f3" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
  ${chartLabels}

  <text class="footer" x="56" y="680">${publicRepositories} public · ${privateRepositories} private · joined ${escapeXml(joinedDate)}</text>
  <text class="footer" x="1044" y="680" text-anchor="end">${escapeXml(profile.location || "GitHub")}</text>
</svg>
`;

const normalizedSvg = `${svg.replace(/[ \t]+$/gm, "").trim()}\n`;

const requiredValues = [
  `data-testid="grade"`,
  `>${displayedGrade}</text>`,
  `data-testid="prs">${formatNumber(totalPullRequests)}</text>`,
  `data-testid="repos">${formatNumber(allRepositories)}</text>`,
  `data-testid="lines_changed">${formatCompactNumber(totalLinesChanged)}</text>`,
  `data-testid="total_contributions">${formatNumber(totalContributions)}</text>`,
];
for (const value of requiredValues) {
  if (!normalizedSvg.includes(value)) {
    throw new Error(`Generated stats card is missing ${value}`);
  }
}

await writeFile(statsPath, normalizedSvg);
console.log(
  `Generated grade ${displayedGrade}, ${totalPullRequests} PRs, ${totalLinesChanged} PR lines changed, ${totalContributions} contributions, current streak ${streaks.current.count}, longest streak ${streaks.longest.count}, and ${allRepositories} repositories.`,
);
