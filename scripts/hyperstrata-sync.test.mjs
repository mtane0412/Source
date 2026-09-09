/**
 * hyperstrata-sync.mjs の純粋関数に対するテスト。
 *
 * Ghost Admin API との通信を伴う処理はテスト対象外とし、
 * 本文HTMLからの引用先slug抽出、タグ差分の計算、
 * Admin API 用トークン生成、不要になった引用タグの判定、graph.json の組み立てを検証する。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';

import {
    extractReferencedSlugs,
    planTagUpdate,
    createAdminToken,
    buildRefTagsQuery,
    selectOrphanRefTags,
    buildGraph,
    serializeGraph,
    GRAPH_JSON_PATH,
    REF_TAG_PREFIX
} from './hyperstrata-sync.mjs';

const サイトURL = 'https://example.com';

/** テスト用の記事URL→slug対応表（Ghost Admin API が返す url を想定） */
const 記事URL対応表 = new Map([
    ['https://example.com/hyperstrata-introduction/', 'hyperstrata-introduction'],
    ['https://example.com/digital-garden-limits/', 'digital-garden-limits'],
    ['https://example.com/correction-of-first-note/', 'correction-of-first-note']
]);

test('extractReferencedSlugs: 絶対URLの内部リンクから引用先slugを抽出する', () => {
    const html = '<p>前回の<a href="https://example.com/hyperstrata-introduction/">紹介記事</a>を参照。</p>';
    const result = extractReferencedSlugs({
        html,
        siteUrl: サイトURL,
        postUrlToSlug: 記事URL対応表,
        selfSlug: 'digital-garden-limits'
    });
    assert.deepEqual(result, ['hyperstrata-introduction']);
});

test('extractReferencedSlugs: 相対パス・クエリ・フラグメント付きのリンクも正規化して抽出する', () => {
    const html = [
        '<a href="/hyperstrata-introduction">末尾スラッシュ無し</a>',
        '<a href="/digital-garden-limits/?ref=note">クエリ付き</a>',
        '<a href=\'/correction-of-first-note/#section\'>フラグメント付き・シングルクォート</a>'
    ].join('');
    const result = extractReferencedSlugs({
        html,
        siteUrl: サイトURL,
        postUrlToSlug: 記事URL対応表,
        selfSlug: 'other-note'
    });
    assert.deepEqual(result, [
        'correction-of-first-note',
        'digital-garden-limits',
        'hyperstrata-introduction'
    ]);
});

test('extractReferencedSlugs: 外部リンク・未知のパス・自分自身へのリンクは無視し、重複は1件にまとめる', () => {
    const html = [
        '<a href="https://other.example.org/hyperstrata-introduction/">外部サイト</a>',
        '<a href="/tag/notes/">記事ではないパス</a>',
        '<a href="/digital-garden-limits/">自分自身</a>',
        '<a href="/hyperstrata-introduction/">1回目</a>',
        '<a href="https://example.com/hyperstrata-introduction/">2回目</a>'
    ].join('');
    const result = extractReferencedSlugs({
        html,
        siteUrl: サイトURL,
        postUrlToSlug: 記事URL対応表,
        selfSlug: 'digital-garden-limits'
    });
    assert.deepEqual(result, ['hyperstrata-introduction']);
});

test('extractReferencedSlugs: 本文が空(null)のときは空配列を返す', () => {
    const result = extractReferencedSlugs({
        html: null,
        siteUrl: サイトURL,
        postUrlToSlug: 記事URL対応表,
        selfSlug: 'digital-garden-limits'
    });
    assert.deepEqual(result, []);
});

test('planTagUpdate: 引用先が既存の引用タグと一致していれば変更なしと判定する', () => {
    const existingTags = [
        {id: 'tag-1', name: 'メモ', slug: 'memo'},
        {id: 'tag-2', name: `${REF_TAG_PREFIX}hyperstrata-introduction`, slug: 'hash-ref-hyperstrata-introduction'}
    ];
    const result = planTagUpdate({existingTags, referencedSlugs: ['hyperstrata-introduction']});
    assert.equal(result.changed, false);
});

test('planTagUpdate: 引用タグ以外の既存タグを維持したまま、引用タグを追加・削除する', () => {
    const existingTags = [
        {id: 'tag-1', name: 'メモ', slug: 'memo'},
        {id: 'tag-2', name: `${REF_TAG_PREFIX}old-note`, slug: 'hash-ref-old-note'},
        {id: 'tag-3', name: '#internal-only', slug: 'hash-internal-only'}
    ];
    const result = planTagUpdate({
        existingTags,
        referencedSlugs: ['hyperstrata-introduction', 'digital-garden-limits']
    });
    assert.equal(result.changed, true);
    assert.deepEqual(result.tags, [
        {id: 'tag-1'},
        {id: 'tag-3'},
        {name: `${REF_TAG_PREFIX}hyperstrata-introduction`, description: 'hyperstrata-introduction'},
        {name: `${REF_TAG_PREFIX}digital-garden-limits`, description: 'digital-garden-limits'}
    ]);
    assert.deepEqual(result.added, ['hyperstrata-introduction', 'digital-garden-limits']);
    assert.deepEqual(result.removed, ['old-note']);
});

test('createAdminToken: Admin APIキーからHS256署名付きのJWTを生成する', () => {
    const keyId = '5f9c2e3a1b2c3d4e5f6a7b8c';
    const secret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const 現在時刻秒 = 1_700_000_000;

    const token = createAdminToken(`${keyId}:${secret}`, 現在時刻秒);
    const [headerPart, payloadPart, signaturePart] = token.split('.');

    const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString());
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString());
    assert.deepEqual(header, {alg: 'HS256', typ: 'JWT', kid: keyId});
    assert.deepEqual(payload, {iat: 現在時刻秒, exp: 現在時刻秒 + 5 * 60, aud: '/admin/'});

    const expectedSignature = createHmac('sha256', Buffer.from(secret, 'hex'))
        .update(`${headerPart}.${payloadPart}`)
        .digest('base64url');
    assert.equal(signaturePart, expectedSignature);
});

test('createAdminToken: "id:secret" 形式でないキーは例外を投げる', () => {
    assert.throws(() => createAdminToken('invalid-key', 0), /GHOST_ADMIN_API_KEY/);
});

test('buildRefTagsQuery: 引用タグ一覧のクエリは "#" を含まず、フィルタが URL エンコードされ、記事数を含める', () => {
    const query = buildRefTagsQuery();
    assert.ok(!query.includes('#'), 'URL クエリに "#" が含まれるとフラグメントとして切り捨てられる');
    assert.equal(query, `/tags/?limit=all&include=count.posts&filter=${encodeURIComponent("slug:~^'hash-ref-'")}`);
});

test('selectOrphanRefTags: どの記事にも付いていない引用タグだけを削除対象にする', () => {
    const tags = [
        {id: 'tag-1', name: `${REF_TAG_PREFIX}old-note`, slug: 'hash-ref-old-note', count: {posts: 0}},
        {id: 'tag-2', name: `${REF_TAG_PREFIX}hyperstrata-introduction`, slug: 'hash-ref-hyperstrata-introduction', count: {posts: 2}},
        {id: 'tag-3', name: `${REF_TAG_PREFIX}renamed-note`, slug: 'hash-ref-renamed-note', count: {posts: 0}}
    ];
    const result = selectOrphanRefTags(tags);
    assert.deepEqual(result.map(tag => tag.id), ['tag-1', 'tag-3']);
});

test('selectOrphanRefTags: 引用タグ以外の内部タグ・公開タグは記事数が0でも削除対象にしない', () => {
    const tags = [
        {id: 'tag-1', name: '#internal-only', slug: 'hash-internal-only', count: {posts: 0}},
        {id: 'tag-2', name: 'メモ', slug: 'memo', count: {posts: 0}},
        {id: 'tag-3', name: `${REF_TAG_PREFIX}old-note`, slug: 'hash-ref-old-note', count: {posts: 0}}
    ];
    const result = selectOrphanRefTags(tags);
    assert.deepEqual(result.map(tag => tag.id), ['tag-3']);
});

test('selectOrphanRefTags: 記事数(count.posts)が取得できていない引用タグがあれば例外を投げる', () => {
    const tags = [
        {id: 'tag-1', name: `${REF_TAG_PREFIX}old-note`, slug: 'hash-ref-old-note'}
    ];
    assert.throws(() => selectOrphanRefTags(tags), /count\.posts/);
});

// ---------------------------------------------------------------------------
// graph.json の生成(#25)
// ---------------------------------------------------------------------------

/** Admin API が返す記事の最小限の形(graph.json 生成に使う項目のみ) */
const グラフ用記事 = [
    {slug: 'hyperstrata-introduction', title: 'Hyperstrata 紹介', url: 'https://example.com/hyperstrata-introduction/', published_at: '2026-01-10T00:00:00.000Z'},
    {slug: 'digital-garden-limits', title: 'デジタルガーデンの限界', url: 'https://example.com/digital-garden-limits/', published_at: '2026-03-01T00:00:00.000Z'},
    {slug: 'correction-of-first-note', title: '最初のノートの訂正', url: 'https://example.com/correction-of-first-note/', published_at: '2026-03-01T00:00:00.000Z'}
];

test('buildGraph: 記事を公開日の降順(同日は slug 順)に並べ、slug/title/url/publishedAt/refs だけを含める', () => {
    const referencedSlugsBySlug = new Map([
        ['hyperstrata-introduction', []],
        ['digital-garden-limits', ['hyperstrata-introduction']],
        ['correction-of-first-note', ['digital-garden-limits', 'hyperstrata-introduction']]
    ]);
    // 入力順に依存しないことを確認するため、公開日順ではない順で渡す
    const graph = buildGraph({posts: [グラフ用記事[0], グラフ用記事[2], グラフ用記事[1]], referencedSlugsBySlug});
    assert.deepEqual(graph, {
        posts: [
            {slug: 'correction-of-first-note', title: '最初のノートの訂正', url: 'https://example.com/correction-of-first-note/', publishedAt: '2026-03-01T00:00:00.000Z', refs: ['digital-garden-limits', 'hyperstrata-introduction']},
            {slug: 'digital-garden-limits', title: 'デジタルガーデンの限界', url: 'https://example.com/digital-garden-limits/', publishedAt: '2026-03-01T00:00:00.000Z', refs: ['hyperstrata-introduction']},
            {slug: 'hyperstrata-introduction', title: 'Hyperstrata 紹介', url: 'https://example.com/hyperstrata-introduction/', publishedAt: '2026-01-10T00:00:00.000Z', refs: []}
        ]
    });
});

test('buildGraph: 引用先の対応表に無い記事があれば例外を投げる(引用抽出の漏れを黙って空にしない)', () => {
    const referencedSlugsBySlug = new Map([['hyperstrata-introduction', []]]);
    assert.throws(() => buildGraph({posts: グラフ用記事, referencedSlugsBySlug}), /digital-garden-limits/);
});

test('serializeGraph: 2 スペースインデントの JSON に末尾改行を付けて返す(差分検出のため出力を安定させる)', () => {
    const graph = {posts: [{slug: 'a', title: 'A', url: '/a/', publishedAt: '2026-01-01T00:00:00.000Z', refs: []}]};
    assert.equal(serializeGraph(graph), JSON.stringify(graph, null, 2) + '\n');
    assert.equal(serializeGraph(graph), serializeGraph(JSON.parse(serializeGraph(graph))));
});

test('GRAPH_JSON_PATH: テーマの assets 配下に置く(テーマ zip に同梱され {{asset}} で配信できる位置)', () => {
    assert.equal(GRAPH_JSON_PATH, 'assets/graph.json');
});
