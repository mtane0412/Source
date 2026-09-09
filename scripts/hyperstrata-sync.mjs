#!/usr/bin/env node
/**
 * Hyperstrata 引用タグ同期スクリプト
 *
 * Ghost Admin API で公開済み記事を全件取得し、本文HTML中の自サイト記事へのリンクから
 * 引用先記事の slug を抽出して、引用する側の記事に内部タグ `#ref-<引用先slug>` を付与する。
 * テーマ側(post.hbs)はこの内部タグを使って References / Cited By を描画する。
 *
 * - 引用タグの `description` には引用先 slug を保存する(テーマが References を引くために使う)
 * - 引用タグ以外の既存タグは維持する
 * - 差分がある記事だけ更新する(冪等)
 * - `--dry-run` を付けると更新内容の表示のみ行う
 *
 * 必要な環境変数(既存の deploy-theme.yml と同じ Secrets):
 *   GHOST_ADMIN_API_URL  例: https://example.com
 *   GHOST_ADMIN_API_KEY  例: <id>:<secret>(Ghost Admin > Integrations の Custom Integration)
 *
 * 実行例:
 *   GHOST_ADMIN_API_URL=... GHOST_ADMIN_API_KEY=... node scripts/hyperstrata-sync.mjs --dry-run
 */
import {createHmac} from 'node:crypto';
import {fileURLToPath} from 'node:url';

/** 引用タグ名の接頭辞。`#` 始まりのため Ghost では内部タグとして扱われる */
export const REF_TAG_PREFIX = '#ref-';
/** Admin API 用 JWT の有効期間(秒)。Ghost の上限は5分 */
const TOKEN_TTL_SECONDS = 5 * 60;
/** Admin API のバージョン指定ヘッダー値 */
const ADMIN_API_VERSION = 'v5.0';

/**
 * Ghost Admin API 用の JWT を生成する。
 *
 * @param {string} apiKey `"<id>:<secret>"` 形式の Admin API キー
 * @param {number} nowSeconds 発行時刻(UNIX秒)。省略時は現在時刻
 * @returns {string} 署名済み JWT
 */
export function createAdminToken(apiKey, nowSeconds = Math.floor(Date.now() / 1000)) {
    const [id, secret] = String(apiKey).split(':');
    if (!id || !secret) {
        throw new Error('GHOST_ADMIN_API_KEY は "<id>:<secret>" 形式である必要があります');
    }
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const header = encode({alg: 'HS256', typ: 'JWT', kid: id});
    const payload = encode({iat: nowSeconds, exp: nowSeconds + TOKEN_TTL_SECONDS, aud: '/admin/'});
    const signature = createHmac('sha256', Buffer.from(secret, 'hex'))
        .update(`${header}.${payload}`)
        .digest('base64url');
    return `${header}.${payload}.${signature}`;
}

/**
 * URL を比較用に正規化する(クエリ・フラグメントを除去し、末尾スラッシュを揃える)。
 *
 * @param {string} href 絶対URLまたは相対パス
 * @param {string} baseUrl 相対パスの解決に使うサイトURL
 * @returns {string|null} 正規化した URL。解析できない場合は null
 */
function normalizeUrl(href, baseUrl) {
    let url;
    try {
        url = new URL(href, baseUrl);
    } catch {
        return null;
    }
    const pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
    return `${url.origin}${pathname}`;
}

/**
 * 記事本文HTMLから、自サイト内の別記事へのリンクを引用先 slug として抽出する。
 *
 * @param {object} params
 * @param {string|null} params.html 記事本文HTML
 * @param {string} params.siteUrl サイトURL(相対リンクの解決に使う)
 * @param {Map<string, string>} params.postUrlToSlug 記事URL→slug の対応表
 * @param {string} params.selfSlug 自分自身の slug(自己参照は除外する)
 * @returns {string[]} 重複を除きソートした引用先 slug の配列
 */
export function extractReferencedSlugs({html, siteUrl, postUrlToSlug, selfSlug}) {
    if (!html) {
        return [];
    }
    const normalizedPostUrlToSlug = new Map();
    for (const [url, slug] of postUrlToSlug) {
        normalizedPostUrlToSlug.set(normalizeUrl(url, siteUrl), slug);
    }

    const slugs = new Set();
    const hrefPattern = /<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    for (const match of html.matchAll(hrefPattern)) {
        const href = match[1] ?? match[2];
        const slug = normalizedPostUrlToSlug.get(normalizeUrl(href, siteUrl));
        if (slug && slug !== selfSlug) {
            slugs.add(slug);
        }
    }
    return [...slugs].sort();
}

/**
 * 記事の現在のタグと引用先 slug を比較し、Admin API に送るタグ配列を組み立てる。
 *
 * @param {object} params
 * @param {Array<{id: string, name: string}>} params.existingTags 記事に現在付いているタグ
 * @param {string[]} params.referencedSlugs 本文から抽出した引用先 slug
 * @returns {{changed: boolean, tags: object[], added: string[], removed: string[]}}
 */
export function planTagUpdate({existingTags, referencedSlugs}) {
    const isRefTag = tag => tag.name.startsWith(REF_TAG_PREFIX);
    const existingRefSlugs = existingTags.filter(isRefTag).map(tag => tag.name.slice(REF_TAG_PREFIX.length));

    const added = referencedSlugs.filter(slug => !existingRefSlugs.includes(slug));
    const removed = existingRefSlugs.filter(slug => !referencedSlugs.includes(slug));
    const tags = [
        ...existingTags.filter(tag => !isRefTag(tag)).map(tag => ({id: tag.id})),
        ...referencedSlugs.map(slug => ({name: `${REF_TAG_PREFIX}${slug}`, description: slug}))
    ];
    return {changed: added.length > 0 || removed.length > 0, tags, added, removed};
}

/**
 * Ghost Admin API の薄いクライアントを生成する。
 *
 * @param {{adminUrl: string, apiKey: string}} config
 */
function createAdminClient({adminUrl, apiKey}) {
    const baseUrl = `${adminUrl.replace(/\/+$/, '')}/ghost/api/admin`;

    async function request(method, path, body) {
        const response = await fetch(`${baseUrl}${path}`, {
            method,
            headers: {
                Authorization: `Ghost ${createAdminToken(apiKey)}`,
                'Accept-Version': ADMIN_API_VERSION,
                'Content-Type': 'application/json'
            },
            body: body ? JSON.stringify(body) : undefined
        });
        if (!response.ok) {
            throw new Error(`Ghost Admin API ${method} ${path} が失敗しました: ${response.status} ${await response.text()}`);
        }
        return response.json();
    }

    return {
        getSiteUrl: async () => (await request('GET', '/site/')).site.url,
        getPublishedPosts: async () => (await request('GET', '/posts/?limit=all&filter=status:published&formats=html&include=tags')).posts,
        updatePostTags: (post, tags) => request('PUT', `/posts/${post.id}/`, {posts: [{tags, updated_at: post.updated_at}]}),
        getRefTags: async () => (await request('GET', `/tags/?limit=all&filter=name:~^'${REF_TAG_PREFIX}'`)).tags,
        updateTagDescription: (tag, description) => request('PUT', `/tags/${tag.id}/`, {tags: [{description}]})
    };
}

/**
 * 引用タグの description に引用先 slug が入っていない場合に補完する。
 * (記事更新時に新規作成されたタグへ description が反映されなかった場合の保険)
 */
async function ensureRefTagDescriptions(client, dryRun) {
    const refTags = await client.getRefTags();
    for (const tag of refTags) {
        const slug = tag.name.slice(REF_TAG_PREFIX.length);
        if (tag.description === slug) {
            continue;
        }
        console.log(`[tag] ${tag.name}: description を "${slug}" に設定`);
        if (!dryRun) {
            await client.updateTagDescription(tag, slug);
        }
    }
}

async function main() {
    const dryRun = process.argv.includes('--dry-run');
    const adminUrl = process.env.GHOST_ADMIN_API_URL;
    const apiKey = process.env.GHOST_ADMIN_API_KEY;
    if (!adminUrl || !apiKey) {
        throw new Error('環境変数 GHOST_ADMIN_API_URL と GHOST_ADMIN_API_KEY を設定してください');
    }

    const client = createAdminClient({adminUrl, apiKey});
    const siteUrl = await client.getSiteUrl();
    const posts = await client.getPublishedPosts();
    const postUrlToSlug = new Map(posts.map(post => [post.url, post.slug]));
    console.log(`公開済み記事 ${posts.length} 件を確認します${dryRun ? '(dry-run)' : ''}`);

    let updatedCount = 0;
    for (const post of posts) {
        const referencedSlugs = extractReferencedSlugs({html: post.html, siteUrl, postUrlToSlug, selfSlug: post.slug});
        const plan = planTagUpdate({existingTags: post.tags ?? [], referencedSlugs});
        if (!plan.changed) {
            continue;
        }
        console.log(`[post] ${post.slug}: 追加=${JSON.stringify(plan.added)} 削除=${JSON.stringify(plan.removed)}`);
        if (!dryRun) {
            await client.updatePostTags(post, plan.tags);
        }
        updatedCount += 1;
    }

    await ensureRefTagDescriptions(client, dryRun);
    console.log(`完了: ${updatedCount} 件の記事を更新${dryRun ? '予定' : ''}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main().catch((error) => {
        console.error(error.message);
        process.exit(1);
    });
}
