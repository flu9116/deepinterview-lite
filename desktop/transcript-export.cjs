function formatTranscript(record, events) {
  const lines = events.filter(e => e.type === 'transcript' && e.final === true &&
    ['candidate', 'interviewer'].includes(e.role) && typeof e.text === 'string' && e.text.trim());
  if (!lines.length) throw new Error('这场录音没有可导出的最终转写，旧录音不会自动补转写。');
  const date = value => Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : '未知';
  return '\uFEFF' + [
    'DeepInterview Lite — 面试转写', `会话：${record.id}`, `开始时间：${date(record.startedAt)}`,
    `结束时间：${date(record.endedAt)}`, `保存状态：${record.status}`,
    '时间为转写接收时间（UTC）；内容为自动识别最终结果，可能存在错漏。',
    '提问方＝系统音频；回答方＝麦克风。不包含 AI 回答提示和复盘建议。', '',
    ...lines.map(e => `[${date(e.at)}] ${e.role === 'candidate' ? '回答方' : '提问方'}：${e.text.trim()}`), '',
  ].join('\r\n');
}
module.exports = { formatTranscript };
