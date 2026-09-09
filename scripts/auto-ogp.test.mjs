/**
 * partials/auto-ogp.hbs（自動 OGP 画像メタタグ）のテスト。
 *
 * Ghost 本体のヘルパー群は使えないため、素の Handlebars でパーシャルを描画し、
 * パーシャルが利用する Ghost ヘルパー `encode` のみ同じ実装（encodeURIComponent）で登録する。
 * `@custom` / `@site` は Handlebars の data 変数として渡す。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import Handlebars from 'handlebars';

const パーシャル = readFileSync(new URL('../partials/auto-ogp.hbs', import.meta.url), 'utf8');

const 生成サーバーURL = 'https://ogp.example.com';

/**
 * パーシャルを描画する。
 *
 * @param {object} 引数
 * @param {object|undefined} 引数.post - ルートコンテキストの post（記事ページ以外では undefined）
 * @param {string|undefined} 引数.ogpGeneratorUrl - テーマ設定 ogp_generator_url
 * @returns {string} 描画結果
 */
function 描画({post, ogpGeneratorUrl}) {
    const hbs = Handlebars.create();
    hbs.registerHelper('encode', string => new hbs.SafeString(encodeURIComponent(string)));
    const template = hbs.compile(パーシャル);
    return template(
        {post},
        {data: {custom: {ogp_generator_url: ogpGeneratorUrl}, site: {title: 'はなしのタネ'}}}
    );
}

const 記事 = {
    title: 'Workers で OGP 画像を自動生成する',
    primary_author: {name: 'たねのぶ'}
};

test('feature image の無い記事では生成サーバーの URL を og:image と twitter:image に出力する', () => {
    const html = 描画({post: 記事, ogpGeneratorUrl: 生成サーバーURL});
    const expectedUrl = 'https://ogp.example.com/og?title=Workers%20%E3%81%A7%20OGP%20%E7%94%BB%E5%83%8F%E3%82%92%E8%87%AA%E5%8B%95%E7%94%9F%E6%88%90%E3%81%99%E3%82%8B&site=%E3%81%AF%E3%81%AA%E3%81%97%E3%81%AE%E3%82%BF%E3%83%8D&author=%E3%81%9F%E3%81%AD%E3%81%AE%E3%81%B6';
    assert.ok(html.includes(`<meta property="og:image" content="${expectedUrl}">`), html);
    assert.ok(html.includes(`<meta name="twitter:image" content="${expectedUrl}">`), html);
    assert.match(html, /<meta property="og:image:width" content="1200">/);
    assert.match(html, /<meta property="og:image:height" content="630">/);
});

test('feature image がある記事では何も出力しない', () => {
    const html = 描画({
        post: {...記事, feature_image: 'https://example.com/content/images/cover.jpg'},
        ogpGeneratorUrl: 生成サーバーURL
    });
    assert.equal(html.trim(), '');
});

test('テーマ設定 ogp_generator_url が空なら何も出力しない', () => {
    assert.equal(描画({post: 記事, ogpGeneratorUrl: ''}).trim(), '');
    assert.equal(描画({post: 記事, ogpGeneratorUrl: undefined}).trim(), '');
});

test('記事ページ以外（post が無いコンテキスト）では何も出力しない', () => {
    const html = 描画({post: undefined, ogpGeneratorUrl: 生成サーバーURL});
    assert.equal(html.trim(), '');
});
