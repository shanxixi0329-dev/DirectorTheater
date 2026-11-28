'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeQueue, normalizeManifest } = require('../src/asset-batch-schema');
const item = (id, fields = {}) => ({ id, category: 'scene', name: id + '布景', source_scenes: ['1-2', '5-1', '9-4'], ...fields });
const queue = (...jobs) => normalizeQueue({ jobs });
const rejection = (code, jobs) => assert.throws(() => queue(...jobs), { code });

test('跳集、母板顺序、造型及视角可往返，不带盘符', () => {
  const q = queue(item('S1', { name: 'SC100_书房', look: '晨光', view: '正打' }),
    item('S2', { references: ['S1'], episodes: [5], source_scenes: ['5-1'] }));
  assert.equal(q.schemaVersion, 1);
  assert.deepEqual(q.jobs[0].episodes, [1, 5, 9]);
  assert.equal(q.jobs[0].relative_path, '02 场景/书房（晨光·正打） 第1集到第9集.png');
  assert.equal(q.jobs[1].relative_path, '02 场景/S2布景 第5集.png');
  assert.deepEqual(normalizeQueue(q), q);
});
test('旧道具分件名称及原有分类子目录', () => {
  const q = queue({ id: 'P', category: 'prop', asset: '工具组', look: '带尺度道具特写', view: '道具特写_卷尺',
    episodes: [1], output_path: 'X:/archive/03 道具/本季/卷尺 第1集.png' });
  assert.equal(q.jobs[0].relative_path, '03 道具/本季/卷尺 第1集.png');
});
test('非法字符、尾部点空格和保留名逐个拦截', () => {
  for (const name of ['A:B', 'A/B', 'A\\B', 'A?', 'A*', 'A"', 'A<', 'A>', 'A|', 'A\u0001', 'A.', 'A '])
    rejection('INVALID_NAME', [item('S', { name })]);
  for (const name of ['CON', 'prn', 'Aux.log', 'NUL', ...Array.from({length:9},(_,i)=>'COM'+(i+1)),
    ...Array.from({length:9},(_,i)=>'LPT'+(i+1)+'.txt')]) rejection('RESERVED_NAME', [item('S', { name })]);
});
test('非法相对路径不能离开归档根目录', () => {
  for (const folder of ['../越界', 'X:/绝对目录', '/外部', '目录//空段'])
    assert.throws(() => normalizeQueue({ jobs: [item('S')], folders: { scene: folder } }), { code: 'INVALID_NAME' });
  assert.throws(() => normalizeManifest({ ...item('S'), relative_path: '../其他.png' }), { code: 'INVALID_NAME' });
});
test('归档目标按 Windows 名称查重', () => rejection('DUPLICATE_TARGET', [item('A', { name: 'Desk' }), item('B', { name: 'desk' })]));
test('任务 ID 重复', () => rejection('DUPLICATE_ID', [item('A'), item('A')]));
test('缺失母板', () => rejection('MISSING_PARENT', [item('A', { references: ['gone'] })]));
test('循环和自引用', () => {
  rejection('CYCLE', [item('A', {references:['B']}), item('B', {references:['A']})]);
  rejection('CYCLE', [item('A', {references:['A']})]);
});
test('存在但排在后面的母板', () => rejection('PARENT_ORDER', [item('B', {references:['A']}), item('A')]));
test('旧绝对路径清单、单图回执和待补项', () => {
  const row = { ...item('S'), episodes: [1, 5, 9], path: 'X:/archive/02 场景/本批/书房.png', actual_model: 'test-provider' };
  const [receipt] = normalizeManifest(row);
  assert.equal(receipt.relative_path, '02 场景/本批/书房.png');
  assert.deepEqual(receipt.source_scenes, ['1-2','5-1','9-4']);
  assert.deepEqual(normalizeManifest({assets:[row],pending:[{id:'pending'}]}), [receipt]);
  assert.deepEqual(normalizeManifest({ ...row, path: '', relative_path: receipt.relative_path })[0].episodes, [1,5,9]);
  assert.throws(() => normalizeManifest({assets:[row, row]}), {code:'DUPLICATE_ID'});
  assert.throws(() => normalizeManifest({assets:[row, {...row, id:'T'}]}), {code:'DUPLICATE_TARGET'});
});
