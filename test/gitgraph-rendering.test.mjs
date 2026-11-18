import { test } from 'node:test';
import { createScratchDirectory } from './helpers/scratch-directory.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, '..', 'archify');
const renderer = path.join(skillRoot, 'renderers', 'gitgraph', 'render-gitgraph.mjs');
const checker = path.join(skillRoot, 'scripts', 'check-render-output.mjs');
const example = JSON.parse(fs.readFileSync(path.join(skillRoot, 'examples', 'release-hotfix.gitgraph.json'), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));

function run(diagram, extra = []) {
  const directory = createScratchDirectory(path.join(os.tmpdir(), 'archify-gitgraph-'));
  const input = path.join(directory, 'candidate.gitgraph.json');
  const output = path.join(directory, 'candidate.html');
  fs.writeFileSync(input, JSON.stringify(diagram));
  return { ...spawnSync(process.execPath, [renderer, input, output, ...extra], { cwd: directory, encoding: 'utf8', timeout: 10000 }), input, output };
}
function layoutOf(diagram) {
  const result = run(diagram, ['--layout-json']);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function failure(mutate) {
  const diagram = clone(example);
  mutate(diagram);
  const result = run(diagram);
  assert.notEqual(result.status, 0, 'invalid graph must not render');
  assert.equal(fs.existsSync(result.output), false, 'no artifact is written for an invalid graph');
  return result.stderr;
}

test('gitgraph: the example renders and passes the showcase artifact checks', () => {
  const result = run(example);
  assert.equal(result.status, 0, result.stderr);
  const html = fs.readFileSync(result.output, 'utf8');
  assert.match(html, /<svg\b[^>]*data-gitgraph-ui=""/);
  for (const commit of example.commits) assert.match(html, new RegExp(`data-node-id="${commit.id}"`));
  assert.match(html, /data-gitgraph-tag="V1\.04-rc1"/);
  assert.match(html, /data-gitgraph-ref="main"/);
  assert.match(html, /data-gitgraph-head="HEAD"/);
  const receipt = JSON.parse(spawnSync(process.execPath, [checker, result.output], { encoding: 'utf8' }).stdout);
  assert.equal(receipt.ok, true, JSON.stringify(receipt.checks.filter((entry) => !entry.ok)));
});

test('gitgraph: omitted parents follow the branch, branch.from starts it, [] is a root', () => {
  const layout = layoutOf(example);
  const parents = Object.fromEntries(layout.commits.map((commit) => [commit.id, commit.parents]));
  assert.deepEqual(parents.v103, []);
  assert.deepEqual(parents.fix, ['v103'], 'first hotfix commit starts at branch.from');
  assert.deepEqual(parents.rc2, ['back-rel'], 'later commit follows the previous commit on its branch');
  assert.deepEqual(parents['back-dev'], ['feat', 'fix'], 'explicit parents are kept in order');
});

test('gitgraph: columns follow commit order and lane changes bend only in text-free gaps', () => {
  const layout = layoutOf(example);
  const xs = layout.commits.map((commit) => commit.x);
  assert.deepEqual(xs, [...xs].sort((a, b) => a - b));
  for (const link of layout.links.filter((entry) => entry.style !== 'straight')) {
    const [g0, g1] = link.bend;
    for (const commit of layout.commits) {
      assert.ok(g1 <= commit.colX0 + 1e-6 || g0 >= commit.colX1 - 1e-6, `${link.from}->${link.to} bends inside the text column of ${commit.id}`);
    }
  }
  assert.ok(layout.links.every((link) => !link.crossesCommit));
});

test('gitgraph: same-lane lines are drawn over lane-change runs so each lane keeps its colour', () => {
  const result = run(example);
  assert.equal(result.status, 0, result.stderr);
  const html = fs.readFileSync(result.output, 'utf8');
  const paths = [...html.matchAll(/<path data-edge-from[^>]* d="([^"]+)"/g)].map((match) => match[1]);
  const straight = paths.map((d) => !d.includes(' C '));
  assert.ok(straight.includes(true) && straight.includes(false));
  assert.ok(straight.indexOf(true) > straight.lastIndexOf(false), 'every straight link is drawn after every bend');
});

test('gitgraph: invalid graphs are refused with a precise diagnostic', () => {
  assert.match(failure((d) => { d.commits[1].branch = 'nope'; }), /gitgraph\/unknown-branch/);
  assert.match(failure((d) => { d.commits[1].parents = ['missing']; }), /gitgraph\/missing-commit/);
  assert.match(failure((d) => { d.commits[1].parents = ['rc2']; }), /gitgraph\/order/);
  assert.match(failure((d) => { d.commits[6].tags = ['V1.03']; }), /gitgraph\/duplicate-tag/);
  assert.match(failure((d) => { d.branches.push({ name: 'unused' }); }), /gitgraph\/empty-branch/);
  assert.match(failure((d) => { d.commits[1].id = 'v103'; }), /gitgraph\/duplicate-id/);
});
