(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DirectorLocalChecks = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const catalog = {
    script: [
      { id: 'sourceDialogue', label: '台词与原文逐字比对', detail: '比对本集绑定原文的引号对话与剧本人物台词。文字不同只表示未匹配，不证明剧情有错。', default: true },
      { id: 'structure', label: '场景与台词可识别性', detail: '识别场景题头和人物台词；识别失败提示人工确认格式。', default: true },
      { id: 'duplicateDialogue', label: '相邻重复台词', detail: '同一人物连续两条完全相同的台词会提示复核；回扣和强调可能合理。', default: false }
    ],
    shotlist: [
      { id: 'balancedMarkers', label: '标记闭合', detail: '检查【】和代码围栏闭合。', default: true },
      { id: 'tailComplete', label: '结尾完整性', detail: '提示可能的文本截断，不判断剧情结尾。', default: true },
      { id: 'tableHeader', label: '分镜表列数', detail: '按现有 12 列分镜格式检查，其他格式可关闭此项。', default: true },
      { id: 'shotNumbering', label: '镜号连续', detail: '按现有分镜镜号格式检查连续性。', default: true }
    ],
    storyboard: [
      { id: 'references', label: '素材 @ 引用', detail: '镜头引用与本集参考素材对照。', default: true },
      { id: 'speakers', label: '单镜头多人发声', detail: '识别同一镜头中多个不同人物的 { } 台词。', default: true },
      { id: 'speechTiming', label: '口播时长估算', detail: '按中文字数和镜头秒数估算，不能代替真实试读。', default: true },
      { id: 'dialogueMatch', label: '台词与说话人一致', detail: '提示词 { } 台词对照本集剧本，同人物连续拆句可合并。', default: true },
      { id: 'dialogueCoverage', label: '剧本台词遗漏', detail: '检查本集剧本人物台词是否进入提示词。', default: true }
    ]
  };
  function normalize(value = {}) {
    const result = { automatic: value.automatic !== false, strictDialogue: value.strictDialogue === true };
    for (const [kind, items] of Object.entries(catalog)) {
      result[kind] = Object.fromEntries(items.map(item => [item.id, typeof value[kind]?.[item.id] === 'boolean' ? value[kind][item.id] : item.default]));
    }
    return result;
  }
  return { catalog, normalize };
});
