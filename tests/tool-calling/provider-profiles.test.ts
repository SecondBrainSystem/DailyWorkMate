import test from 'node:test'
import assert from 'node:assert/strict'
import { getProviderToolProfile } from '../../src/main/proxy/toolCalling/providerProfiles.ts'

const calls = [
  { id: 'call_1', name: 'default_api:read_file', arguments: '{"filePath":"/tmp/a"}' },
]

test('first-version providers use managed prompt and managed xml by default', () => {
  for (const providerId of ['deepseek', 'kimi', 'glm', 'qwen']) {
    const profile = getProviderToolProfile(providerId)

    assert.equal(profile.managedSupport, true)
    assert.equal(profile.supportsNativeTools, false)
    assert.equal(profile.preferredManagedProtocol, 'managed_xml')
  }
})

test('priority providers format tool history with the DailyWorkMate XML protocol', () => {
  for (const providerId of ['deepseek', 'kimi', 'glm', 'qwen']) {
    const profile = getProviderToolProfile(providerId)

    assert.equal(
      profile.formatAssistantToolCalls(calls),
      '<|DAILYWORKMATE|tool_calls><|DAILYWORKMATE|invoke name="default_api:read_file"><|DAILYWORKMATE|parameter name="filePath"><![CDATA[/tmp/a]]></|DAILYWORKMATE|parameter></|DAILYWORKMATE|invoke></|DAILYWORKMATE|tool_calls>',
    )
    assert.equal(
      profile.formatToolResult({ toolCallId: 'call_1', content: 'file body' }),
      '<|DAILYWORKMATE|tool_result tool_call_id="call_1"><![CDATA[file body]]></|DAILYWORKMATE|tool_result>',
    )
  }
})
