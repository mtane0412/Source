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

test('buildLayout: ノードは新しい記事が上(公開日の降順)に並び、y座標が単調増加する', () => {
    const {buildLayout} = 読み込む();
    const layout = buildLayout([記事[2], 記事[0], 記事[1]], {minGap: 40, pixelsPerDay: 1});
    // 地表(上)が新しい記事、深い層(下)が古い記事
    assert.deepEqual(layout.nodes.map(node => node.slug), ['correction', 'limits', 'introduction']);
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
    assert.deepEqual(layout.nodes.map(node => node.slug), ['b', 'a']);
    assert.equal(layout.nodes[1].y - layout.nodes[0].y, 40);
});

test('buildLayout: 経過日数に応じて間隔が広がる(pixelsPerDay)', () => {
    const {buildLayout} = 読み込む();
    const layout = buildLayout([記事[0], 記事[1]], {minGap: 40, pixelsPerDay: 2});
    // 2026-01-10 → 2026-03-01 は 50 日。新しい limits が上(y 小)、古い introduction が下(y 大)
    assert.deepEqual(layout.nodes.map(node => node.slug), ['limits', 'introduction']);
    assert.equal(layout.nodes[1].y - layout.nodes[0].y, 100);
});

test('buildLayout: 引用関係は「引用元 → 引用先」のエッジになり(新しい記事の順)、種別が付く', () => {
    const {buildLayout} = 読み込む();
    const layout = buildLayout(記事, {minGap: 40, pixelsPerDay: 1});
    assert.deepEqual(layout.edges, [
        {from: 'correction', to: 'introduction', kind: 'correction'},
        {from: 'limits', to: 'introduction', kind: ''}
    ]);
});

test('buildLayout: 一覧に存在しない slug への引用はエッジにしない', () => {
    const {buildLayout} = 読み込む();
    const layout = buildLayout(記事, {minGap: 40, pixelsPerDay: 1});
    assert.ok(layout.edges.every(edge => edge.to !== 'unknown-slug'));
});

test('buildLayout: 年ごとの区切り(yearMarks)は新しい年から順に、その年で最も新しいノードの位置に置く', () => {
    const {buildLayout} = 読み込む();
    const 複数年 = [
        {slug: 'a', title: 'a', url: '/a/', publishedAt: '2025-12-31T00:00:00.000Z', refs: [], kind: ''},
        {slug: 'b', title: 'b', url: '/b/', publishedAt: '2026-01-01T00:00:00.000Z', refs: [], kind: ''},
        {slug: 'c', title: 'c', url: '/c/', publishedAt: '2026-06-01T00:00:00.000Z', refs: [], kind: ''}
    ];
    const layout = buildLayout(複数年, {minGap: 40, pixelsPerDay: 1});
    // ノードは c(2026-06), b(2026-01), a(2025-12) の順。2026 の区切りは c、2025 の区切りは a の位置
    assert.deepEqual(layout.yearMarks.map(mark => mark.year), [2026, 2025]);
    assert.equal(layout.yearMarks[0].y, layout.nodes[0].y);
    assert.equal(layout.yearMarks[1].y, layout.nodes[2].y);
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

/* ------------------------------------------------------------------
 * 記事ページ左側の固定ペイン(partials/strata-pane.hbs)向けレイアウト
 * ------------------------------------------------------------------ */

/** ペイン用 API も含めて読み込む */
function ペインを読み込む() {
    const window = {};
    vm.runInNewContext(スクリプト, {window});
    const api = window.HyperstrataGraph;
    const 正規化 = value => JSON.parse(JSON.stringify(value));
    return {
        buildPaneLayout: (posts, options) => 正規化(api.buildPaneLayout(posts, options)),
        assignLanes: edges => 正規化(api.assignLanes(edges)),
        computeEmphasis: (nodes, edges, slug, hops) => 正規化(api.computeEmphasis(nodes, edges, slug, hops)),
        buildStrataBands: (marks, height) => 正規化(api.buildStrataBands(marks, height)),
        strataBoundaryPath: (y, width, options) => api.strataBoundaryPath(y, width, options)
    };
}

const ペイン設定 = {rowHeight: 26, monthGap: 30, paddingTop: 20, paddingBottom: 40};

/** 月ラベルはローカル時刻で判定するため、日付は月の中旬(タイムゾーンで月が変わらない)にする */
const ペイン記事 = [
    {slug: 'oldest', title: '最初の記事', url: '/oldest/', publishedAt: '2026-01-15T12:00:00.000Z', refs: [], kind: ''},
    {slug: 'middle', title: '中間の記事', url: '/middle/', publishedAt: '2026-01-20T12:00:00.000Z', refs: ['oldest'], kind: ''},
    {slug: 'newest', title: '最新の記事', url: '/newest/', publishedAt: '2026-03-15T12:00:00.000Z', refs: ['oldest'], kind: 'supplement'}
];

test('buildPaneLayout: ノードは新しい記事が上(row 0)になり、y が行ごとに増える', () => {
    const {buildPaneLayout} = ペインを読み込む();
    const layout = buildPaneLayout(ペイン記事, ペイン設定);
    assert.deepEqual(layout.nodes.map(node => node.slug), ['newest', 'middle', 'oldest']);
    assert.deepEqual(layout.nodes.map(node => node.row), [0, 1, 2]);
    assert.ok(layout.nodes[0].y < layout.nodes[1].y);
    assert.ok(layout.nodes[1].y < layout.nodes[2].y);
    // 同じ月の隣接ノードは rowHeight ぶんだけ離れる
    assert.equal(layout.nodes[2].y - layout.nodes[1].y, ペイン設定.rowHeight);
});

test('buildPaneLayout: 月が変わるごとに YYYY-MM の区切りを置き、monthGap ぶん余白を空ける', () => {
    const {buildPaneLayout} = ペインを読み込む();
    const layout = buildPaneLayout(ペイン記事, ペイン設定);
    assert.deepEqual(layout.monthMarks.map(mark => mark.label), ['2026-03', '2026-01']);
    // 区切りは各月の最初のノードより上にある
    assert.ok(layout.monthMarks[0].y < layout.nodes[0].y);
    assert.ok(layout.monthMarks[1].y < layout.nodes[1].y);
    assert.ok(layout.monthMarks[1].y > layout.nodes[0].y);
    // 月をまたぐ隣接ノードは rowHeight + monthGap ぶん離れる
    assert.equal(layout.nodes[1].y - layout.nodes[0].y, ペイン設定.rowHeight + ペイン設定.monthGap);
    assert.equal(layout.height, layout.nodes[2].y + ペイン設定.paddingBottom);
});

test('buildPaneLayout: エッジは行番号(fromRow/toRow)とレーンを持ち、fromRow < toRow になる', () => {
    const {buildPaneLayout} = ペインを読み込む();
    const layout = buildPaneLayout(ペイン記事, ペイン設定);
    assert.deepEqual(
        layout.edges.map(edge => [edge.from, edge.to, edge.fromRow, edge.toRow, edge.kind]),
        [
            ['newest', 'oldest', 0, 2, 'supplement'],
            ['middle', 'oldest', 1, 2, '']
        ]
    );
    assert.ok(layout.edges.every(edge => typeof edge.lane === 'number'));
});

test('buildPaneLayout: 空配列でも空のレイアウトを返す', () => {
    const {buildPaneLayout} = ペインを読み込む();
    assert.deepEqual(buildPaneLayout([], ペイン設定), {nodes: [], edges: [], monthMarks: [], laneCount: 0, height: 0});
});

test('assignLanes: 隣接行を結ぶエッジはレーン 0(直線)になる', () => {
    const {assignLanes} = ペインを読み込む();
    const edges = assignLanes([{fromRow: 0, toRow: 1}]);
    assert.equal(edges[0].lane, 0);
});

test('assignLanes: 行範囲が重なるエッジは別のレーンに割り当てる', () => {
    const {assignLanes} = ペインを読み込む();
    const edges = assignLanes([{fromRow: 0, toRow: 3}, {fromRow: 1, toRow: 3}, {fromRow: 2, toRow: 4}]);
    // 0→3 / 1→3 / 2→4 はいずれも行 2〜3 で重なるので、3 本とも別レーン(1 以上)になる
    const lanes = edges.map(edge => edge.lane);
    assert.equal(new Set(lanes).size, 3);
    assert.ok(lanes.every(lane => lane >= 1));
});

test('assignLanes: 端の行だけを共有するエッジ(0→2 と 2→4)は同じレーンを再利用できる', () => {
    const {assignLanes} = ペインを読み込む();
    const edges = assignLanes([{fromRow: 0, toRow: 2}, {fromRow: 2, toRow: 4}]);
    assert.equal(edges[0].lane, 1);
    assert.equal(edges[1].lane, 1);
});

test('assignLanes: 入力の並び順を保ち、元の配列を変更しない', () => {
    const {assignLanes} = ペインを読み込む();
    const 入力 = [{fromRow: 2, toRow: 5, from: 'b'}, {fromRow: 0, toRow: 3, from: 'a'}];
    const edges = assignLanes(入力);
    assert.deepEqual(edges.map(edge => edge.from), ['b', 'a']);
    assert.equal('lane' in 入力[0], false);
});

/** 引用チェーン: a → b → c → d(矢印は「引用する → 引用される」)、e は孤立 */
const 連鎖エッジ = [
    {from: 'a', to: 'b'},
    {from: 'b', to: 'c'},
    {from: 'c', to: 'd'}
];
const 連鎖ノード = [{slug: 'a'}, {slug: 'b'}, {slug: 'c'}, {slug: 'd'}, {slug: 'e'}];

test('computeEmphasis: 現在記事から引用の向きを問わず 2 ホップまでの距離を返す', () => {
    const {computeEmphasis} = ペインを読み込む();
    const emphasis = computeEmphasis(連鎖ノード, 連鎖エッジ, 'b', 2);
    assert.deepEqual(emphasis.nodes, {b: 0, a: 1, c: 1, d: 2});
});

test('computeEmphasis: エッジの距離は両端ノードの近いほうの距離 + 1 になる', () => {
    const {computeEmphasis} = ペインを読み込む();
    const emphasis = computeEmphasis(連鎖ノード, 連鎖エッジ, 'b', 2);
    assert.deepEqual(emphasis.edges, [1, 1, 2]);
});

test('computeEmphasis: ホップ数の上限を超えるノード・エッジは含めない(距離 -1)', () => {
    const {computeEmphasis} = ペインを読み込む();
    const emphasis = computeEmphasis(連鎖ノード, 連鎖エッジ, 'a', 1);
    assert.deepEqual(emphasis.nodes, {a: 0, b: 1});
    assert.deepEqual(emphasis.edges, [1, -1, -1]);
});

test('computeEmphasis: 現在記事がグラフに無ければ何も強調しない', () => {
    const {computeEmphasis} = ペインを読み込む();
    const emphasis = computeEmphasis(連鎖ノード, 連鎖エッジ, 'missing', 2);
    assert.deepEqual(emphasis.nodes, {});
    assert.deepEqual(emphasis.edges, [-1, -1, -1]);
});

test('computeEmphasis: 現在記事の slug が空(トップページ)なら中立モードになり、何も暗くしない(距離 null)', () => {
    const {computeEmphasis} = ペインを読み込む();
    const emphasis = computeEmphasis(連鎖ノード, 連鎖エッジ, '', 2);
    assert.equal(emphasis.neutral, true);
    assert.deepEqual(emphasis.nodes, {});
    assert.deepEqual(emphasis.edges, [null, null, null]);
});

/* ------------------------------------------------------------------
 * 孤立した現在記事の強調(引用が無い記事でもノードとして存在すれば距離 0 にする)
 * ------------------------------------------------------------------ */

test('computeEmphasis: 引用が無い孤立した現在記事でも、ノードに存在すれば距離 0 で強調し、他はすべて暗くする', () => {
    const {computeEmphasis} = ペインを読み込む();
    const ノード = [{slug: 'a'}, {slug: 'b'}, {slug: 'c'}, {slug: 'd'}, {slug: 'lonely'}];
    const emphasis = computeEmphasis(ノード, 連鎖エッジ, 'lonely', 2);
    assert.equal(emphasis.neutral, false);
    assert.deepEqual(emphasis.nodes, {lonely: 0});
    assert.deepEqual(emphasis.edges, [-1, -1, -1]);
});

/* ------------------------------------------------------------------
 * 地層の帯(月ごとの区切りの間を地層として塗り分ける)
 * ------------------------------------------------------------------ */

test('buildStrataBands: 月の区切りごとに帯を作り、上から順に深さ(depth)が増える', () => {
    const {buildStrataBands} = ペインを読み込む();
    const bands = buildStrataBands([{label: '2026-03', y: 15}, {label: '2026-01', y: 71}], 140);
    assert.deepEqual(bands, [
        {label: '2026-03', top: 15, bottom: 71, depth: 0},
        {label: '2026-01', top: 71, bottom: 140, depth: 1}
    ]);
});

test('buildStrataBands: 区切りが無ければ帯も無い', () => {
    const {buildStrataBands} = ペインを読み込む();
    assert.deepEqual(buildStrataBands([], 100), []);
});

test('strataBoundaryPath: 波線は指定した y から始まり、右端(width)まで到達する', () => {
    const {strataBoundaryPath} = ペインを読み込む();
    const path = strataBoundaryPath(50, 200, {amplitude: 2, wavelength: 40});
    assert.match(path, /^M 0 50 /);
    // 最後の座標の x は width に一致する
    const 座標 = path.trim().split(/\s+/);
    assert.equal(Number(座標[座標.length - 2]), 200);
});
