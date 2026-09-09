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
 * - どの記事にも付いていない引用タグ(引用先 slug の変更やリンク削除で不要になったもの)は削除する
 * - 公開記事の一覧と引用関係を Hyperstrata グラフ用の `assets/graph.json` に書き出す
 *   (テーマの assets/js/strata-graph.js が fetch して描画する。`{{#get}}` の 100 件上限と
 *   全ページへの一覧埋め込みを避けるため、テーマ側ではなく本スクリプトで生成する)
 * - `--dry-run` を付けると更新・削除内容と graph.json の差分有無の表示のみ行う
 *
 * 必要な環境変数(既存の deploy-theme.yml と同じ Secrets):
 *   GHOST_ADMIN_API_URL  例: https://example.com
 *   GHOST_ADMIN_API_KEY  例: <id>:<secret>(Ghost Admin > Integrations の Custom Integration)
 *
 * 実行例:
 *   GHOST_ADMIN_API_URL=... GHOST_ADMIN_API_KEY=... node scripts/hyperstrata-sync.mjs --dry-run
 */
import {createHmac} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

/** 引用タグ名の接頭辞。`#` 始まりのため Ghost では内部タグとして扱われる */
export const REF_TAG_PREFIX = '#ref-';
/** 引用タグの slug 接頭辞。Ghost は `#` 始まりのタグ名から `hash-` 始まりの slug を生成する */
const REF_TAG_SLUG_PREFIX = 'hash-ref-';
/** Admin API 用 JWT の有効期間(秒)。Ghost の上限は5分 */
const TOKEN_TTL_SECONDS = 5 * 60;
/** Admin API のバージョン指定ヘッダー値 */
const ADMIN_API_VERSION = 'v5.0';
/**
 * Hyperstrata グラフ用 JSON の書き出し先(リポジトリルートからの相対パス)。
 * テーマ zip に同梱され、テンプレートから `{{asset "graph.json"}}` で参照できる位置に置く。
 */
export const GRAPH_JSON_PATH = 'assets/graph.json';

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
 * 引用タグ一覧を取得する Admin API のパスとクエリを組み立てる。
 *
 * タグ名(`#ref-`)ではなく slug(`hash-ref-`)でフィルタする。URL クエリに `#` を含めると
 * フラグメントとして切り捨てられフィルタが壊れるため。フィルタ文字列は URL エンコードする。
 * 不要タグの判定に使うため、各タグに付いている記事数(`count.posts`)も含めて取得する。
 *
 * @returns {string} `/tags/?limit=all&include=count.posts&filter=...`
 */
export function buildRefTagsQuery() {
    return `/tags/?limit=all&include=count.posts&filter=${encodeURIComponent(`slug:~^'${REF_TAG_SLUG_PREFIX}'`)}`;
}

/**
 * どの記事にも付いていない引用タグ(削除対象)を選び出す。
 *
 * 引用タグ以外のタグは記事数に関わらず対象外とする。引用タグに `count.posts` が無い場合は
 * 取得クエリの不備とみなし、誤削除を避けるため例外を投げる。
 *
 * @param {Array<{id: string, name: string, count?: {posts?: number}}>} tags Admin API から取得したタグ
 * @returns {Array<{id: string, name: string}>} 削除対象の引用タグ
 */
export function selectOrphanRefTags(tags) {
    return tags.filter((tag) => {
        if (!tag.name.startsWith(REF_TAG_PREFIX)) {
            return false;
        }
        const postCount = tag.count?.posts;
        if (typeof postCount !== 'number') {
            throw new Error(`引用タグ ${tag.name} に count.posts が含まれていません(include=count.posts を確認してください)`);
        }
        return postCount === 0;
    });
}

/**
 * Hyperstrata グラフ用 JSON(graph.json)の内容を組み立てる。
 *
 * 記事は公開日の降順(新しい記事が先頭)、同じ公開日は slug 順に並べ、入力順に依存しない
 * 安定した出力にする(差分の有無で更新要否を判定するため)。引用先は引用タグではなく
 * 本文から抽出した slug をそのまま使う(公開済み記事へのリンクだけが含まれる)。
 *
 * @param {object} params
 * @param {Array<{slug: string, title: string, url: string, published_at: string}>} params.posts 公開済み記事
 * @param {Map<string, string[]>} params.referencedSlugsBySlug 記事 slug → 引用先 slug の対応表
 * @returns {{posts: Array<{slug: string, title: string, url: string, publishedAt: string, refs: string[]}>}}
 */
export function buildGraph({posts, referencedSlugsBySlug}) {
    const nodes = posts.map((post) => {
        const refs = referencedSlugsBySlug.get(post.slug);
        if (!refs) {
            throw new Error(`記事 ${post.slug} の引用先が対応表にありません`);
        }
        return {slug: post.slug, title: post.title, url: post.url, publishedAt: post.published_at, refs};
    });
    nodes.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.slug.localeCompare(b.slug));
    return {posts: nodes};
}

/**
 * graph.json の内容を、差分検出しやすい安定した文字列(2 スペースインデント・末尾改行)にする。
 *
 * @param {ReturnType<typeof buildGraph>} graph
 * @returns {string}
 */
export function serializeGraph(graph) {
    return `${JSON.stringify(graph, null, 2)}\n`;
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
        // DELETE は 204 No Content を返すため、本文が無い場合は null を返す
        if (response.status === 204) {
            return null;
        }
        return response.json();
    }

    return {
        getSiteUrl: async () => (await request('GET', '/site/')).site.url,
        getPublishedPosts: async () => (await request('GET', '/posts/?limit=all&filter=status:published&formats=html&include=tags')).posts,
        updatePostTags: (post, tags) => request('PUT', `/posts/${post.id}/`, {posts: [{tags, updated_at: post.updated_at}]}),
        getRefTags: async () => (await request('GET', buildRefTagsQuery())).tags,
        updateTagDescription: (tag, description) => request('PUT', `/tags/${tag.id}/`, {tags: [{description}]}),
        deleteTag: tag => request('DELETE', `/tags/${tag.id}/`)
    };
}

/**
 * 引用タグの description に引用先 slug が入っていない場合に補完する。
 * (記事更新時に新規作成されたタグへ description が反映されなかった場合の保険)
 */
async function ensureRefTagDescriptions(client, refTags, dryRun) {
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

/**
 * どの記事にも付いていない引用タグを削除する。
 * (引用先 slug の変更や本文からのリンク削除で不要になったタグが管理画面に残り続けるのを防ぐ)
 *
 * @returns {Promise<number>} 削除した(dry-run 時は削除予定の)タグ数
 */
async function pruneOrphanRefTags(client, refTags, dryRun) {
    const orphanTags = selectOrphanRefTags(refTags);
    for (const tag of orphanTags) {
        console.log(`[tag] ${tag.name}: どの記事にも付いていないため削除`);
        if (!dryRun) {
            await client.deleteTag(tag);
        }
    }
    return orphanTags.length;
}

/**
 * graph.json を書き出す。既存ファイルと内容が同じなら書き込まない(差分の有無を戻り値で返す)。
 * ファイルが無い場合は初回生成として差分ありとみなす。
 *
 * @param {ReturnType<typeof buildGraph>} graph
 * @param {boolean} dryRun true のときは差分の有無だけ表示して書き込まない
 * @returns {Promise<boolean>} 差分があった(書き込んだ、または dry-run で書き込む予定の)場合 true
 */
async function writeGraphJson(graph, dryRun) {
    const next = serializeGraph(graph);
    const graphPath = new URL(`../${GRAPH_JSON_PATH}`, import.meta.url);
    let current = null;
    try {
        current = await readFile(graphPath, 'utf8');
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }
    if (current === next) {
        return false;
    }
    console.log(`[graph] ${GRAPH_JSON_PATH}: ${graph.posts.length} 件の記事で${current === null ? '新規作成' : '更新'}`);
    if (!dryRun) {
        await writeFile(graphPath, next);
    }
    return true;
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

    const referencedSlugsBySlug = new Map(posts.map(post => [
        post.slug,
        extractReferencedSlugs({html: post.html, siteUrl, postUrlToSlug, selfSlug: post.slug})
    ]));

    let updatedCount = 0;
    for (const post of posts) {
        const referencedSlugs = referencedSlugsBySlug.get(post.slug);
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

    // 記事更新後の状態でタグ一覧を取得し、description の補完と不要タグの削除に使う
    const refTags = await client.getRefTags();
    await ensureRefTagDescriptions(client, refTags, dryRun);
    const prunedCount = await pruneOrphanRefTags(client, refTags, dryRun);
    const graphChanged = await writeGraphJson(buildGraph({posts, referencedSlugsBySlug}), dryRun);
    console.log(`完了: ${updatedCount} 件の記事を更新、${prunedCount} 件の引用タグを削除${dryRun ? '予定' : ''}、graph.json は${graphChanged ? '更新' : '変更なし'}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main().catch((error) => {
        console.error(error.message);
        process.exit(1);
    });
}
