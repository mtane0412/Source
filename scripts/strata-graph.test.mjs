/**
 * assets/js/strata-graph.js の純粋関数(レイアウト計算)に対するテスト。
 *
 * テーマの JS は gulp で連結されるブラウザ向けスクリプトのため、ESM として import できない。
 * そのため node:vm で読み込み、window.HyperstrataGraph に公開された関数を検証する。
 * DOM 操作(SVG 描画)はテスト対象外とする。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const スクリプト = readFileSync(new URL('../assets/js/strata-graph.js', import.meta.url), 'utf8');

/**
 * strata-graph.js をブラウザ環境なし(document 未定義)で評価し、公開 API を取り出す。
 * vm の別レルムで生成された配列・オブジェクトは assert.deepEqual(strict) でプロトタイプ不一致になるため、
 * buildLayout の戻り値は JSON を経由してテスト側レルムの値に正規化する。
 */
function 読み込む() {
    const window = {};
    vm.runInNewContext(スクリプト, {window});
    const api = window.HyperstrataGraph;
    return {
        buildLayout: (posts, options) => JSON.parse(JSON.stringify(api.buildLayout(posts, options)))
    };
}

const 記事 = [
    {slug: 'introduction', title: '紹介記事', url: '/introduction/', publishedAt: '2026-01-10T00:00:00.000Z', refs: [], kind: ''},
    {slug: 'limits', title: '限界について', url: '/limits/', publishedAt: '2026-03-01T00:00:00.000Z', refs: ['introduction'], kind: ''},
    {slug: 'correction', title: '紹介記事の訂正', url: '/correction/', publishedAt: '2026-05-20T00:00:00.000Z', refs: ['introduction', 'unknown-slug'], kind: 'correction'}
];

test('buildLayout: ノードは公開日の昇順に並び、y座標が単調増加する', () => {
    const {buildLayout} = 読み込む();
    const layout = buildLayout([記事[2], 記事[0], 記事[1]], {minGap: 40, pixelsPerDay: 1});
    assert.deepEqual(layout.nodes.map(node => node.slug), ['introduction', 'limits', 'correction']);
    assert.ok(layout.nodes[0].y < layout.nodes[1].y);
    assert.ok(layout.nodes[1].y < layout.nodes[2].y);
});

test('buildLayout: 近接する公開日でも最小間隔(minGap)を確保する', () => {
    const {buildLayout} = 読み込む();
    const 同日 = [
        {slug: 'a', title: 'a', url: '/a/', publishedAt: '2026-01-01T00:00:00.000Z', refs: [], kind: ''},
        {slug: 'b', title: 'b', url: '/b/', publishedAt: '2026-01-01T01:00:00.000Z', refs: [], kind: ''}
    ];
    const layout = buildLayout(同日, {minGap: 40, pixelsPerDay: 1});
    assert.equal(layout.nodes[1].y - layout.nodes[0].y, 40);
});

test('buildLayout: 経過日数に応じて間隔が広がる(pixelsPerDay)', () => {
    const {buildLayout} = 読み込む();
    const layout = buildLayout([記事[0], 記事[1]], {minGap: 40, pixelsPerDay: 2});
    // 2026-01-10 → 2026-03-01 は 50 日
    assert.equal(layout.nodes[1].y - layout.nodes[0].y, 100);
});

test('buildLayout: 引用関係は「引用元 → 引用先」のエッジになり、種別が付く', () => {
    const {buildLayout} = 読み込む();
    const layout = buildLayout(記事, {minGap: 40, pixelsPerDay: 1});
    assert.deepEqual(layout.edges, [
        {from: 'limits', to: 'introduction', kind: ''},
        {from: 'correction', to: 'introduction', kind: 'correction'}
    ]);
});

test('buildLayout: 一覧に存在しない slug への引用はエッジにしない', () => {
    const {buildLayout} = 読み込む();
    const layout = buildLayout(記事, {minGap: 40, pixelsPerDay: 1});
    assert.ok(layout.edges.every(edge => edge.to !== 'unknown-slug'));
});

test('buildLayout: 年が変わる最初のノードに年ラベルを付ける', () => {
    const {buildLayout} = 読み込む();
    const 複数年 = [
        {slug: 'a', title: 'a', url: '/a/', publishedAt: '2025-12-31T00:00:00.000Z', refs: [], kind: ''},
        {slug: 'b', title: 'b', url: '/b/', publishedAt: '2026-01-01T00:00:00.000Z', refs: [], kind: ''},
        {slug: 'c', title: 'c', url: '/c/', publishedAt: '2026-06-01T00:00:00.000Z', refs: [], kind: ''}
    ];
    const layout = buildLayout(複数年, {minGap: 40, pixelsPerDay: 1});
    assert.deepEqual(layout.yearMarks.map(mark => mark.year), [2025, 2026]);
    assert.equal(layout.yearMarks[1].y, layout.nodes[1].y);
});

test('buildLayout: 空配列でもノード・エッジ・年ラベルが空の結果を返す', () => {
    const {buildLayout} = 読み込む();
    const layout = buildLayout([], {minGap: 40, pixelsPerDay: 1});
    assert.deepEqual(layout, {nodes: [], edges: [], yearMarks: [], height: 0});
});

test('buildLayout: 公開日が解釈できないノードは Fail-Fast で例外にする', () => {
    const {buildLayout} = 読み込む();
    assert.throws(
        () => buildLayout([{slug: 'x', title: 'x', url: '/x/', publishedAt: 'not-a-date', refs: [], kind: ''}], {minGap: 40, pixelsPerDay: 1}),
        /公開日/
    );
});
