/**
 * hyperstrata-sync.mjs の純粋関数に対するテスト。
 *
 * Ghost Admin API との通信を伴う処理はテスト対象外とし、
 * 本文HTMLからの引用先slug抽出、タグ差分の計算、
 * Admin API 用トークン生成、不要になった引用タグの判定を検証する。
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
