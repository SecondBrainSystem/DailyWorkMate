import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const skillPaths = [
  {
    file: 'skills/dailyworkmate-management-api/SKILL.md',
    name: 'dailyworkmate-management-api',
    description:
      "Use when operating DailyWorkMate Manager's management API for testing, including health checks, config snapshots, temporary API keys, model mappings, sessions, logs, and cleanup verification.",
  },
  {
    file: 'skills/dailyworkmate-har-tool-fixture/SKILL.md',
    name: 'dailyworkmate-har-tool-fixture',
    description:
      'Use when converting OpenAI-compatible client HAR files into sanitized replayable DailyWorkMate tool-calling fixtures.',
  },
  {
    file: 'skills/dailyworkmate-tool-client-replay/SKILL.md',
    name: 'dailyworkmate-tool-client-replay',
    description:
      'Use when replaying sanitized client tool-calling fixtures against DailyWorkMate with client-specific pass/fail rules.',
  },
  {
    file: 'skills/dailyworkmate-provider-model-matrix/SKILL.md',
    name: 'dailyworkmate-provider-model-matrix',
    description:
      'Use when running DailyWorkMate provider and model matrix tests using live /v1/models discovery and management API attribution.',
  },
  {
    file: 'skills/dailyworkmate-proxy-testing/SKILL.md',
    name: 'dailyworkmate-proxy-testing',
    description:
      'Use when validating DailyWorkMate Manager proxy behavior across dialogue, tool calling, context, provider routing, request logs, and live client replay workflows.',
  },
]

const focusedSkillFiles = skillPaths.filter(({ name }) => name !== 'dailyworkmate-proxy-testing').map(({ file }) => file)
const implementedScriptPaths = [
  'skills/dailyworkmate-management-api/scripts/management-api.mjs',
  'skills/dailyworkmate-har-tool-fixture/scripts/extract-har-fixtures.mjs',
  'skills/dailyworkmate-tool-client-replay/scripts/replay-client-fixture.mjs',
  'skills/dailyworkmate-provider-model-matrix/scripts/run-model-matrix.mjs',
]

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

test('versioned DailyWorkMate testing skills exist and have trigger-only descriptions', () => {
  for (const { file, name, description } of skillPaths) {
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    // Skill frontmatter is a discovery contract; keep exact names and descriptions stable.
    assert.match(
      text,
      new RegExp(`^---\\nname: ${escapeRegExp(name)}\\ndescription: ${escapeRegExp(description)}\\n---`, 'm'),
      file,
    )
    assert.doesNotMatch(text, /T[B]D|FI[X]ME|deferred work/, file)
  }
})

test('focused skill docs reference implemented script paths only', () => {
  for (const file of focusedSkillFiles) {
    const text = fs.readFileSync(file, 'utf8')
    assert.doesNotMatch(text, /Planned Script/, file)
  }

  for (const file of implementedScriptPaths) {
    assert.equal(fs.existsSync(file), true, file)
  }
})

test('proxy testing skill delegates focused responsibilities', () => {
  const text = fs.readFileSync('skills/dailyworkmate-proxy-testing/SKILL.md', 'utf8')
  assert.match(text, /dailyworkmate-management-api/)
  assert.match(text, /dailyworkmate-har-tool-fixture/)
  assert.match(text, /dailyworkmate-tool-client-replay/)
  assert.match(text, /dailyworkmate-provider-model-matrix/)
})

test('versioned proxy testing skill warns against ignored local source of truth', () => {
  const text = fs.readFileSync('skills/dailyworkmate-proxy-testing/SKILL.md', 'utf8')
  assert.match(text, /versioned source of truth/)
  assert.match(text, /ignored \.codex/)
})
