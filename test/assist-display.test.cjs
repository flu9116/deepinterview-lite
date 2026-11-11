const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const browser = {};
vm.runInNewContext(readFileSync(join(__dirname, '..', 'desktop', 'assist-display.js'), 'utf8'), browser);
const { nextHintText, shouldPublishHint } = browser;
test('keeps previous answer stable for every draft and stream update, then swaps only a full final', () => {
  let visible = '結論：関係者と品質基準を先に確認します。';
  const draft = visible;
  for (const event of [
    { phase: 'draft', text: '' },
    { phase: 'generating' },
    { phase: 'generating', text: '結論' },
    { phase: 'generating', text: '結論：納期と品質の' },
    { phase: 'generating', hasPoint: false, text: '資料不足：関連する個人資料が見つかりません。\n結' },
    { phase: 'draft', text: '結論：納期と品質の条件を確認して優先順位を決めます。' },
    { phase: 'generating', hasPoint: true, text: '新しい完全な一文でも、回答全体はまだ未完成です。' },
  ]) {
    visible = nextHintText(visible, event);
    assert.equal(visible, draft);
  }
  assert.equal(nextHintText(visible, { phase: 'final', text: '最終版。' }), '最終版。');
  assert.equal(nextHintText('', { phase: 'draft', text: '結' }), '');
  assert.equal(nextHintText(visible, { phase: 'error', draft: true, text: '草稿エラー' }), visible);
});
test('backend does not publish draft text or partial final text to the UI', () => {
  for (const event of [
    { type: 'assist', phase: 'draft', text: '草稿' },
    { type: 'assist', phase: 'generating', text: '部分' },
    { type: 'assist', phase: 'error', draft: true, text: '草稿失敗' },
  ]) assert.equal(shouldPublishHint(event), false);
  assert.equal(shouldPublishHint({ type: 'assist', phase: 'final' }), true);
  assert.equal(shouldPublishHint({ type: 'assist', phase: 'error', draft: false }), true);
});
