import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { esc, renderDefinitions, textUnits } from '../shared/utils.mjs';
import {
  animateAttr,
  focusEdgeAttrs,
  focusNodeAttrs,
  focusNodeTitle,
  loadDiagram,
  svgAccessibleText,
  svgRootAttrs,
  writeDiagram,
} from '../shared/cli.mjs';
import { throwDiagnosticProblems } from '../shared/diagnostics.mjs';
import { legendFootprint, resolveLegend, renderLegend as renderResolvedLegend } from '../shared/legend.mjs';
import { nodeTextFit } from '../shared/text-fit.mjs';
import { translateMessage as i18nText } from '../shared/i18n.mjs';
import { asArray } from '../shared/geometry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const layoutJsonMode = process.argv.includes('--layout-json');
const cliArgs = process.argv.filter((arg) => arg !== '--layout-json');
const { diagram: gg, template, outPath, sourceEvidence } = loadDiagram({
  rendererDir: __dirname,
  diagramType: 'gitgraph',
  defaultExample: 'release-hotfix.gitgraph.json',
  argv: cliArgs,
});
const locale = gg.meta.locale;
const ADVANCE = nodeTextFit.widthFactor;
const textW = (text, size) => textUnits(text) * size * ADVANCE;

const layout = {
  margin: 28,
  top: 24,
  laneNameFont: 12.5,
  captionFont: 10.5,
  labelFont: 11.5,
  messageFont: 10.5,
  pillFont: 10,
  pillH: 17,
  pillGap: 3,
  dotR: 7,
  minColumn: 40,
  gap: 26, // text-free gap between columns; every lane change bends here
  laneGapAbove: 10,
  laneGapBelow: 14,
  laneColumnGap: 22,
};

// ---- Graph checks --------------------------------------------------------------
// Columns are the authored commit order, so a parent must be drawn left of its
// child. Every reference must name a declared branch or commit.
const problems = [];
const details = [];
function fail(code, message, subject, evidence, supportedFixes) {
  problems.push(message);
  details.push({ code, severity: 'error', message, subject: { diagramType: 'gitgraph', ...subject }, evidence, supportedFixes });
}
const branches = asArray(gg.branches);
const rawCommits = asArray(gg.commits);
const branchIndex = new Map();
for (const [index, branch] of branches.entries()) {
  if (branchIndex.has(branch.name)) fail('gitgraph/duplicate-branch', `Branch "${branch.name}" is declared twice.`, { path: `/branches/${index}/name` }, { name: branch.name }, ['Declare each branch once.']);
  else branchIndex.set(branch.name, index);
}
const commitIndex = new Map();
for (const [index, commit] of rawCommits.entries()) {
  if (commitIndex.has(commit.id)) fail('gitgraph/duplicate-id', `Commit id "${commit.id}" is declared twice.`, { path: `/commits/${index}/id` }, { id: commit.id }, ['Give every commit a unique id.']);
  else commitIndex.set(commit.id, index);
  if (!branchIndex.has(commit.branch)) {
    fail('gitgraph/unknown-branch', `Commit "${commit.id}" is on branch "${commit.branch}", which is not declared.`, { path: `/commits/${index}/branch`, nodeId: commit.id },
      { branch: commit.branch, declared: [...branchIndex.keys()] }, ['Add the branch to branches[].', 'Correct the branch name.']);
  }
}
const earlier = (id, index) => commitIndex.has(id) && commitIndex.get(id) < index;
const refCheck = (id, index, pathSuffix, what, subjectId) => {
  if (!commitIndex.has(id)) {
    fail('gitgraph/missing-commit', `${what} "${id}" is not a declared commit.`, { path: pathSuffix, nodeId: subjectId }, { commit: id }, ['Declare the commit.', 'Correct the commit id.']);
  } else if (index !== null && !earlier(id, index)) {
    fail('gitgraph/order', `${what} "${id}" must appear before commit "${subjectId}" in commits[]; columns follow commit order.`, { path: pathSuffix, nodeId: subjectId },
      { commit: id, at: commitIndex.get(id), child: index }, ['Move the parent earlier in commits[].']);
  }
};
for (const [index, branch] of branches.entries()) {
  if (branch.from !== undefined) refCheck(branch.from, null, `/branches/${index}/from`, `Branch "${branch.name}" starts from`, undefined);
}
for (const [index, commit] of rawCommits.entries()) {
  for (const [p, parent] of asArray(commit.parents).entries()) refCheck(parent, index, `/commits/${index}/parents/${p}`, `Parent`, commit.id);
  if (commit.cherry_pick_of !== undefined) refCheck(commit.cherry_pick_of, index, `/commits/${index}/cherry_pick_of`, 'Cherry-pick source', commit.id);
}
{
  const seen = new Map();
  for (const [index, commit] of rawCommits.entries()) {
    for (const [t, tag] of asArray(commit.tags).entries()) {
      if (seen.has(tag)) fail('gitgraph/duplicate-tag', `Tag "${tag}" is on both "${seen.get(tag)}" and "${commit.id}"; a tag names one commit.`, { path: `/commits/${index}/tags/${t}`, nodeId: commit.id }, { tag }, ['Keep the tag on one commit.']);
      else seen.set(tag, commit.id);
    }
  }
}
for (const [index, branch] of branches.entries()) {
  if (!rawCommits.some((commit) => commit.branch === branch.name)) {
    fail('gitgraph/empty-branch', `Branch "${branch.name}" has no commits, so it has no lane to draw.`, { path: `/branches/${index}` }, { name: branch.name },
      ['Remove the branch and show it as a ref on the commit it points at (commits[].refs).']);
  }
}
if (problems.length) throwDiagnosticProblems('Gitgraph validation failed', problems, { code: 'gitgraph/input', subject: { diagramType: 'gitgraph' }, diagnostics: details });

// ---- Graph model ---------------------------------------------------------------
// Omitted parents mean "the previous commit on this branch", or the branch's
// `from` commit for its first commit; [] states a root explicitly.
const lastOnBranch = new Map();
const commits = rawCommits.map((commit, index) => {
  const branch = branches[branchIndex.get(commit.branch)];
  const implied = lastOnBranch.get(commit.branch) ?? branch.from;
  const parents = commit.parents ?? (implied !== undefined ? [implied] : []);
  lastOnBranch.set(commit.branch, commit.id);
  const kind = commit.kind || 'normal';
  return { ...commit, index, lane: branchIndex.get(commit.branch), parents, kind, merge: parents.length > 1, tags: asArray(commit.tags), refs: asArray(commit.refs), display: commit.label ?? commit.id };
});
const byId = new Map(commits.map((commit) => [commit.id, commit]));
const firstOnLane = new Map();
for (const commit of commits) if (!firstOnLane.has(commit.lane)) firstOnLane.set(commit.lane, commit.id);

// ---- Tones ---------------------------------------------------------------------
// Each branch gets a palette family in lane order. Red is kept for highlighted
// commits (e.g. the two sides of a conflict) so it never reads as a branch.
const LANE_TONES = ['backend', 'frontend', 'database', 'cloud', 'messagebus', 'external'];
const laneTone = (lane) => LANE_TONES[lane % LANE_TONES.length];

// ---- Geometry ------------------------------------------------------------------
const pillWidth = (text) => Math.ceil(textW(text, layout.pillFont) + 16);
const pillsOf = (commit) => [
  ...commit.tags.map((text) => ({ text, kind: 'tag' })),
  ...commit.refs.map((text) => ({ text, kind: text === 'HEAD' ? 'head' : 'ref' })),
];
for (const commit of commits) {
  commit.pills = pillsOf(commit);
  commit.columnW = Math.ceil(Math.max(
    layout.minColumn,
    textW(commit.display, layout.labelFont) + 6,
    commit.message ? textW(commit.message, layout.messageFont) + 6 : 0,
    ...commit.pills.map((pill) => pillWidth(pill.text)),
  ));
}
const laneNameW = (branch) => Math.max(textW(branch.name, layout.laneNameFont) * 1.04, branch.caption ? textW(branch.caption, layout.captionFont) : 0);
const laneLabelW = Math.ceil(14 + Math.max(...branches.map(laneNameW)));
const columnsX0 = layout.margin + laneLabelW + layout.laneColumnGap;
let cursor = columnsX0;
for (const commit of commits) {
  commit.colX0 = cursor;
  commit.colX1 = cursor + commit.columnW;
  commit.x = Math.round((cursor + commit.columnW / 2) * 100) / 100;
  cursor = commit.colX1 + layout.gap;
}
const columnsX1 = cursor - layout.gap;

// Each lane reserves room above the dots for its tallest pill stack and below
// for the label and message lines, so nothing on one lane reaches the next.
const LABEL_LINE = 14;
const MESSAGE_LINE = 13;
const lanes = branches.map((branch, lane) => {
  const own = commits.filter((commit) => commit.lane === lane);
  const maxPills = Math.max(0, ...own.map((commit) => commit.pills.length));
  const above = layout.laneGapAbove + layout.dotR + (maxPills ? maxPills * (layout.pillH + layout.pillGap) + 4 : 0);
  const hasMessage = own.some((commit) => commit.message);
  const below = layout.dotR + 6 + LABEL_LINE + (hasMessage ? MESSAGE_LINE : 0) + layout.laneGapBelow;
  const captionRoom = branch.caption ? 16 : 0;
  return { ...branch, lane, tone: laneTone(lane), above: Math.max(above, 16), below: Math.max(below, 22 + captionRoom) };
});
{
  let y = layout.top;
  for (const lane of lanes) {
    lane.top = y;
    lane.y = y + lane.above;
    y = lane.y + lane.below;
    lane.bottom = y;
  }
}
for (const commit of commits) commit.y = lanes[commit.lane].y;

// ---- Links ---------------------------------------------------------------------
// Same lane: a straight line. Different lane: horizontal on one lane, a bend
// inside a text-free column gap, then horizontal on the other lane. A branch
// cut bends right after the parent (the new lane is empty before its first
// commit); a merge bends right before the child. If the merge route would run
// over another commit on the source lane, the branch-style bend is used.
// ponytail: one lane per branch and no lane reuse; a graph with many
// short-lived branches grows tall. Reuse finished lanes if that becomes a problem.
const occupied = (lane, fromIndex, toIndex) => commits.some((commit) => commit.lane === lane && commit.index > fromIndex && commit.index < toIndex);
function route(parent, child) {
  if (parent.lane === child.lane) return { style: 'straight', d: `M ${parent.x} ${parent.y} H ${child.x}` };
  const branchCut = firstOnLane.get(child.lane) === child.id;
  const mergeBlocked = occupied(parent.lane, parent.index, child.index);
  const cutBlocked = occupied(child.lane, parent.index, child.index);
  const style = branchCut || (mergeBlocked && !cutBlocked) ? 'cut' : 'merge';
  const gx0 = style === 'cut' ? parent.colX1 : child.colX0 - layout.gap;
  const gx1 = gx0 + layout.gap;
  const mid = (gx0 + gx1) / 2;
  const d = `M ${parent.x} ${parent.y} H ${gx0} C ${mid} ${parent.y} ${mid} ${child.y} ${gx1} ${child.y} H ${child.x}`;
  return { style, d, bend: [gx0, gx1], crossesCommit: style === 'merge' ? mergeBlocked : cutBlocked };
}
const links = [];
for (const child of commits) {
  for (const [order, parentId] of child.parents.entries()) {
    const parent = byId.get(parentId);
    const r = route(parent, child);
    // A link takes the colour of the lane it leaves for (cut) or comes from (merge).
    const tone = r.style === 'cut' ? laneTone(child.lane) : laneTone(parent.lane);
    links.push({ from: parent.id, to: child.id, kind: 'parent', order, tone, ...r });
  }
  if (child.cherry_pick_of !== undefined) {
    const source = byId.get(child.cherry_pick_of);
    const r = route(source, child);
    links.push({ from: source.id, to: child.id, kind: 'cherry-pick', order: 0, tone: laneTone(source.lane), ...r });
  }
}

// ---- Legend & canvas -----------------------------------------------------------
const presentKinds = new Set([
  ...commits.filter((commit) => commit.merge).map(() => 'merge'),
  ...commits.filter((commit) => commit.kind !== 'normal').map((commit) => commit.kind),
  ...(links.some((link) => link.kind === 'cherry-pick') ? ['cherry-pick'] : []),
]);
const legendEntries = resolveLegend(undefined, ['merge', 'highlight', 'reverse', 'cherry-pick']
  .map((kind) => ({ kind, label: i18nText(locale, `legend.gitgraph.${kind === 'cherry-pick' ? 'cherryPick' : kind}`), tone: 'external', interactive: false })), presentKinds);
const width = Math.ceil(columnsX1 + layout.margin);
const contentBottom = lanes.at(-1).bottom;
const footprint = legendFootprint(legendEntries, { width: width - layout.margin * 2, fontSize: 11 });
const height = Math.ceil(contentBottom + layout.margin + (legendEntries.length ? 34 + footprint.extraHeight : 0));
const viewBox = [width, height];

// ---- Rendering -----------------------------------------------------------------
function renderLanes() {
  return lanes.map((lane) => {
    const own = commits.filter((commit) => commit.lane === lane.lane);
    const start = lane.from !== undefined ? byId.get(lane.from).x : own[0].x;
    const nameY = lane.y + 4.3;
    return `        <g data-gitgraph-lane="${esc(lane.name)}">
          <rect x="${layout.margin - 8}" y="${lane.top}" width="${width - layout.margin * 2 + 16}" height="${lane.bottom - lane.top}" rx="8" class="gg-band${lane.lane % 2 ? ' gg-band-alt' : ''}"/>
          <line x1="${start}" y1="${lane.y}" x2="${columnsX1}" y2="${lane.y}" class="gg-guide" stroke-width="1"/>
          <circle cx="${layout.margin + 4}" cy="${lane.y}" r="4.5" class="t-${lane.tone} gg-lane-dot"/>
          <text x="${layout.margin + 14}" y="${nameY}" class="t-primary gg-mono" font-size="${layout.laneNameFont}" font-weight="700">${esc(lane.name)}</text>
          ${lane.caption ? `<text x="${layout.margin + 14}" y="${nameY + 15}" class="t-muted" font-size="${layout.captionFont}">${esc(lane.caption)}</text>` : ''}
        </g>`;
  }).join('\n');
}

function renderLinks() {
  // Lane changes first, straight same-lane links last: where a bend's
  // horizontal run shares a lane with that lane's own line, the lane keeps its
  // colour. data-edge-key stays the authored link index.
  const drawOrder = links.map((link, index) => ({ link, index })).sort((a, b) => (a.link.style === 'straight') - (b.link.style === 'straight') || a.index - b.index);
  return drawOrder.map(({ link, index }) => `        <path ${focusEdgeAttrs(link.from, link.to, link.kind === 'cherry-pick' ? i18nText(locale, 'legend.gitgraph.cherryPick') : undefined, index)} d="${link.d}" class="gg-link gg-${link.tone}${link.kind === 'cherry-pick' ? ' gg-cherry' : ''}" stroke-width="${link.kind === 'cherry-pick' ? 1.6 : 2.4}" fill="none" stroke-linecap="round"/>`).join('\n');
}

function renderMark(commit) {
  const { x, y } = commit;
  const r = layout.dotR;
  const tone = laneTone(commit.lane);
  if (commit.kind === 'highlight') return `<rect x="${x - r}" y="${y - r}" width="${r * 2}" height="${r * 2}" rx="3" class="gg-fill-security gg-mark" stroke-width="0"/>`;
  if (commit.kind === 'reverse') {
    const k = r * 0.5;
    return `<circle cx="${x}" cy="${y}" r="${r}" class="gg-fill-${tone} gg-mark"/><path d="M ${x - k} ${y - k} L ${x + k} ${y + k} M ${x + k} ${y - k} L ${x - k} ${y + k}" class="gg-cross" stroke-width="2" stroke-linecap="round"/>`;
  }
  if (commit.merge) return `<circle cx="${x}" cy="${y}" r="${r}" class="gg-ring gg-${tone} gg-mark" stroke-width="2.6"/><circle cx="${x}" cy="${y}" r="${r * 0.38}" class="gg-fill-${tone}"/>`;
  return `<circle cx="${x}" cy="${y}" r="${r}" class="gg-fill-${tone} gg-mark"/>`;
}

function renderPills(commit) {
  // Tags stack on top, then refs, then HEAD nearest the dot.
  const ordered = [...commit.pills.filter((p) => p.kind === 'tag'), ...commit.pills.filter((p) => p.kind === 'ref'), ...commit.pills.filter((p) => p.kind === 'head')];
  return ordered.map((pill, i) => {
    const fromDot = ordered.length - i;
    const w = pillWidth(pill.text);
    const py = commit.y - layout.dotR - 4 - fromDot * (layout.pillH + layout.pillGap) + layout.pillGap;
    const refLane = branchIndex.get(pill.text);
    const tone = pill.kind === 'tag' ? 'external' : pill.kind === 'head' ? 'messagebus' : refLane !== undefined ? laneTone(refLane) : 'external';
    const shape = pill.kind === 'tag' ? 2.5 : layout.pillH / 2;
    return `<g data-gitgraph-${pill.kind}="${esc(pill.text)}"><rect x="${commit.x - w / 2}" y="${py}" width="${w}" height="${layout.pillH}" rx="${shape}" class="c-${tone}${pill.kind === 'head' ? ' gg-head' : ''}" stroke-width="1"/><text x="${commit.x}" y="${py + layout.pillH / 2 + 3.6}" class="t-${tone} gg-mono" font-size="${layout.pillFont}" font-weight="700" text-anchor="middle">${esc(pill.text)}</text></g>`;
  }).join('');
}

function renderCommit(commit, order) {
  const branch = lanes[commit.lane];
  const parentsText = commit.parents.length ? i18nText(locale, 'gitgraph.parents', { parents: commit.parents.map((id) => byId.get(id).display).join(', ') }) : '';
  const passport = {
    kind: laneTone(commit.lane),
    sublabel: [commit.message, commit.detail].filter(Boolean).join(' — ') || undefined,
    context: [branch.name, parentsText, commit.tags.join(', ')].filter(Boolean).join(' › '),
  };
  const labelY = commit.y + layout.dotR + 6 + 10;
  return `        <g ${focusNodeAttrs(commit.id, commit.display, passport, locale)} data-gitgraph-branch="${esc(branch.name)}" data-gitgraph-parents="${esc(commit.parents.join(' '))}" data-gitgraph-kind="${commit.merge && commit.kind === 'normal' ? 'merge' : commit.kind}"${animateAttr(gg.meta, 'node', order)}>
          ${focusNodeTitle(commit.display, passport)}
          <rect x="${commit.colX0}" y="${branch.top + 2}" width="${commit.columnW}" height="${branch.bottom - branch.top - 4}" rx="6" class="c-mask gg-hit"/>
          ${renderMark(commit)}
          ${renderPills(commit)}
          <text data-node-label="" x="${commit.x}" y="${labelY}" class="t-primary gg-mono" font-size="${layout.labelFont}" font-weight="650" text-anchor="middle">${esc(commit.display)}</text>
          ${commit.message ? `<text x="${commit.x}" y="${labelY + MESSAGE_LINE}" class="t-muted" font-size="${layout.messageFont}" text-anchor="middle">${esc(commit.message)}</text>` : ''}
        </g>`;
}

function legendSwatch(entry) {
  const cx = entry.x + 7;
  const cy = entry.baseline - 4;
  if (entry.kind === 'merge') return `<circle cx="${cx}" cy="${cy}" r="5" class="gg-ring gg-external" stroke-width="2"/>`;
  if (entry.kind === 'highlight') return `<rect x="${cx - 5}" y="${cy - 5}" width="10" height="10" rx="2" class="gg-fill-security"/>`;
  if (entry.kind === 'reverse') return `<circle cx="${cx}" cy="${cy}" r="5" class="gg-fill-external"/><path d="M ${cx - 2.5} ${cy - 2.5} L ${cx + 2.5} ${cy + 2.5} M ${cx + 2.5} ${cy - 2.5} L ${cx - 2.5} ${cy + 2.5}" class="gg-cross" stroke-width="1.5"/>`;
  return `<path d="M ${entry.x} ${cy} H ${entry.x + 14}" class="gg-link gg-external gg-cherry" stroke-width="1.6"/>`;
}

const TONES = ['frontend', 'backend', 'database', 'cloud', 'messagebus', 'security', 'external'];

function renderSvg() {
  return `      <svg viewBox="0 0 ${viewBox[0]} ${viewBox[1]}" ${svgRootAttrs(gg.meta)} data-gitgraph-ui="" data-reader-fit="width-first" data-reader-min-text="7.5">
${svgAccessibleText(gg.meta, 'gitgraph')}
${renderDefinitions()}
        <style>
          svg[data-gitgraph-ui] .gg-band { fill: transparent; }
          svg[data-gitgraph-ui] .gg-band-alt { fill: var(--lane-fill); fill-opacity: 1; opacity: .55; }
          svg[data-gitgraph-ui] .gg-guide { stroke: var(--lane-stroke); stroke-dasharray: 2 4; opacity: .8; }
          svg[data-gitgraph-ui] .gg-hit { fill: transparent; stroke: none; }
          svg[data-gitgraph-ui] .gg-ring { fill: var(--bg, #fff); }
          svg[data-gitgraph-ui] .gg-cross { stroke: var(--bg, #fff); }
          svg[data-gitgraph-ui] .gg-cherry { stroke-dasharray: 5 4; }
          svg[data-gitgraph-ui] .gg-head { stroke-width: 1.6; }
          svg[data-gitgraph-ui] .gg-mono { font-family: var(--font-mono, ui-monospace, monospace); }
          svg[data-gitgraph-ui] [data-node-id] > rect { filter: none !important; }
${TONES.map((tone) => `          svg[data-gitgraph-ui] .gg-${tone} { stroke: var(--${tone}-stroke); }
          svg[data-gitgraph-ui] .gg-fill-${tone} { fill: var(--${tone}-stroke); stroke: none; }`).join('\n')}
        </style>

        <!-- Background Grid -->
        <rect width="100%" height="100%" fill="url(#grid)" />

        <!-- Branch lanes, top to bottom in authored order -->
${renderLanes()}

        <!-- Parent links (lane changes bend only in text-free column gaps) -->
${renderLinks()}

        <!-- Commits, left to right in authored order -->
${commits.map(renderCommit).join('\n')}

        <!-- Legend -->
${legendEntries.length ? renderResolvedLegend({ entries: legendEntries, locale, layout: { x: layout.margin, baselineY: height - 16, width: width - layout.margin * 2, fontSize: 11, minTitleY: contentBottom + 8, diagramType: 'gitgraph' }, renderSwatch: legendSwatch }) : ''}
      </svg>`;
}

function buildLayoutReport() {
  return {
    diagram_type: 'gitgraph',
    viewBox,
    lanes: lanes.map((lane) => ({ name: lane.name, y: lane.y, top: lane.top, bottom: lane.bottom })),
    commits: commits.map((commit) => ({ id: commit.id, branch: commit.branch, parents: commit.parents, x: commit.x, y: commit.y, colX0: commit.colX0, colX1: commit.colX1 })),
    links: links.map((link) => ({ from: link.from, to: link.to, kind: link.kind, style: link.style, bend: link.bend ?? null, crossesCommit: Boolean(link.crossesCommit) })),
  };
}

if (layoutJsonMode) {
  console.log(JSON.stringify(buildLayoutReport(), null, 2));
  process.exit(0);
}
writeDiagram({
  outPath,
  template,
  diagramType: 'gitgraph',
  meta: gg.meta,
  svg: renderSvg(),
  cards: gg.cards,
  sourceEvidence,
});
