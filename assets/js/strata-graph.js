/**
 * Hyperstrata 引用グラフビュー
 *
 * custom-strata.hbs がサーバー側で描画した記事一覧(data 属性に slug / 公開日 / 引用先 / 種別を持つ)を
 * 読み取り、縦軸を時間(公開日)としたアーク図を SVG で描画する。外部ライブラリには依存しない。
 *
 * - ノード: 記事。クリックで記事ページへ遷移する
 * - エッジ: 引用関係(引用元 → 引用先)。種別タグ(#correction 等)があれば線の見た目を変える
 * - JavaScript が無効な環境では元の記事一覧がそのまま表示される
 *
 * レイアウト計算(buildLayout)は DOM に依存しない純粋関数として window.HyperstrataGraph に公開し、
 * scripts/strata-graph.test.mjs から検証する。
 */
(function () {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    /** 引用の種別。data-kind に入る値と一致させる */
    const KNOWN_KINDS = ['correction', 'supplement', 'continuation', 'reversal'];

    /**
     * 記事一覧からグラフのレイアウト(ノード座標・エッジ・年ラベル)を計算する。
     *
     * y 座標は公開日の経過日数 × pixelsPerDay を基本とし、隣接ノードとの間隔が minGap を下回る場合は
     * minGap まで押し下げる(同日公開の記事が重ならないようにするため)。
     *
     * @param {Array<{slug: string, title: string, url: string, publishedAt: string, refs: string[], kind: string}>} posts
     * @param {{minGap: number, pixelsPerDay: number}} options
     * @returns {{nodes: object[], edges: object[], yearMarks: object[], height: number}}
     */
    function buildLayout(posts, options) {
        const sorted = posts
            .map(function (post) {
                const time = Date.parse(post.publishedAt);
                if (Number.isNaN(time)) {
                    throw new Error('公開日を解釈できません: ' + post.slug + ' (' + post.publishedAt + ')');
                }
                return Object.assign({}, post, {time: time});
            })
            .sort(function (a, b) {
                return a.time - b.time;
            });

        if (sorted.length === 0) {
            return {nodes: [], edges: [], yearMarks: [], height: 0};
        }

        const nodes = [];
        const yearMarks = [];
        const firstTime = sorted[0].time;
        let previousY = -Infinity;
        let previousYear = null;

        sorted.forEach(function (post) {
            const scaledY = ((post.time - firstTime) / MS_PER_DAY) * options.pixelsPerDay;
            const y = Math.max(scaledY, previousY + options.minGap);
            const year = new Date(post.time).getFullYear();
            if (year !== previousYear) {
                yearMarks.push({year: year, y: y});
                previousYear = year;
            }
            nodes.push({slug: post.slug, title: post.title, url: post.url, publishedAt: post.publishedAt, kind: post.kind, y: y});
            previousY = y;
        });

        const slugs = new Set(nodes.map(function (node) {
            return node.slug;
        }));
        const edges = [];
        sorted.forEach(function (post) {
            post.refs.forEach(function (ref) {
                if (slugs.has(ref) && ref !== post.slug) {
                    edges.push({from: post.slug, to: ref, kind: post.kind});
                }
            });
        });

        return {nodes: nodes, edges: edges, yearMarks: yearMarks, height: previousY};
    }

    /**
     * 記事一覧(<li data-slug ...>)からレイアウト計算用の記事配列を作る。
     *
     * @param {HTMLElement} list
     */
    function readPostsFromList(list) {
        return Array.from(list.querySelectorAll('[data-slug]')).map(function (item) {
            const link = item.querySelector('a');
            const refs = (item.dataset.refs || '').split(',').filter(Boolean);
            return {
                slug: item.dataset.slug,
                title: link.textContent.trim(),
                url: link.getAttribute('href'),
                publishedAt: item.dataset.published,
                refs: refs,
                kind: KNOWN_KINDS.indexOf(item.dataset.kind) === -1 ? '' : item.dataset.kind
            };
        });
    }

    function createElement(name, attributes) {
        const element = document.createElementNS(SVG_NS, name);
        Object.keys(attributes).forEach(function (key) {
            element.setAttribute(key, attributes[key]);
        });
        return element;
    }

    /** 表示用にタイトルを一定文字数で切り詰める(全文は <title> でツールチップ表示する) */
    function truncate(text, maxLength) {
        return text.length > maxLength ? text.slice(0, maxLength - 1) + '…' : text;
    }

    /**
     * レイアウトを SVG として描画する。
     *
     * @param {ReturnType<typeof buildLayout>} layout
     * @param {{axisX: number, paddingTop: number, paddingBottom: number, width: number, maxArcWidth: number, nodeRadius: number, titleMaxLength: number}} options
     * @returns {SVGSVGElement}
     */
    function renderSvg(layout, options) {
        const height = layout.height + options.paddingTop + options.paddingBottom;
        const svg = createElement('svg', {
            class: 'gh-strata-svg',
            viewBox: '0 0 ' + options.width + ' ' + height,
            width: options.width,
            height: height,
            role: 'img'
        });
        const nodeY = {};
        layout.nodes.forEach(function (node) {
            nodeY[node.slug] = node.y + options.paddingTop;
        });

        // 時間軸
        svg.appendChild(createElement('line', {
            class: 'gh-strata-axis',
            x1: options.axisX, y1: options.paddingTop - options.nodeRadius * 2,
            x2: options.axisX, y2: height - options.paddingBottom + options.nodeRadius * 2
        }));
        layout.yearMarks.forEach(function (mark) {
            const label = createElement('text', {
                class: 'gh-strata-year',
                x: options.axisX + options.nodeRadius * 2 + 4,
                y: mark.y + options.paddingTop - options.nodeRadius * 2
            });
            label.textContent = String(mark.year);
            svg.appendChild(label);
        });

        // エッジ(引用元 → 引用先)。時間軸の左側に楕円弧として描く
        const edgeGroup = createElement('g', {class: 'gh-strata-edges'});
        layout.edges.forEach(function (edge) {
            const fromY = nodeY[edge.from];
            const toY = nodeY[edge.to];
            const ry = Math.abs(fromY - toY) / 2;
            const rx = Math.min(ry, options.maxArcWidth);
            // 引用元(新しい記事)から引用先(古い記事)へ、左に膨らむ弧を描く
            const sweep = fromY > toY ? 1 : 0;
            const path = createElement('path', {
                class: 'gh-strata-edge' + (edge.kind ? ' is-' + edge.kind : ''),
                d: 'M ' + options.axisX + ' ' + fromY + ' A ' + rx + ' ' + ry + ' 0 0 ' + sweep + ' ' + options.axisX + ' ' + toY,
                'data-from': edge.from,
                'data-to': edge.to
            });
            edgeGroup.appendChild(path);
        });
        svg.appendChild(edgeGroup);

        // ノード(記事)。<a> で包み、クリックで記事ページへ遷移する
        const nodeGroup = createElement('g', {class: 'gh-strata-nodes'});
        layout.nodes.forEach(function (node) {
            const y = nodeY[node.slug];
            const anchor = createElement('a', {class: 'gh-strata-node', href: node.url, 'data-slug': node.slug});
            const tooltip = createElement('title', {});
            tooltip.textContent = node.title;
            anchor.appendChild(tooltip);
            anchor.appendChild(createElement('circle', {
                class: 'gh-strata-dot' + (node.kind ? ' is-' + node.kind : ''),
                cx: options.axisX, cy: y, r: options.nodeRadius
            }));
            const title = createElement('text', {
                class: 'gh-strata-title',
                x: options.axisX + options.nodeRadius * 2 + 4,
                y: y + 4
            });
            title.textContent = truncate(node.title, options.titleMaxLength);
            anchor.appendChild(title);
            anchor.addEventListener('mouseenter', function () {
                highlight(svg, node.slug, true);
            });
            anchor.addEventListener('mouseleave', function () {
                highlight(svg, node.slug, false);
            });
            nodeGroup.appendChild(anchor);
        });
        svg.appendChild(nodeGroup);
        return svg;
    }

    /** ノードにマウスを乗せたとき、関係するエッジを強調する */
    function highlight(svg, slug, on) {
        svg.classList.toggle('is-highlighting', on);
        Array.from(svg.querySelectorAll('.gh-strata-edge')).forEach(function (edge) {
            const related = edge.dataset.from === slug || edge.dataset.to === slug;
            edge.classList.toggle('is-active', on && related);
        });
    }

    function init() {
        const container = document.querySelector('[data-strata]');
        if (!container) {
            return;
        }
        const list = container.querySelector('[data-strata-list]');
        const posts = readPostsFromList(list);
        if (posts.length === 0) {
            return;
        }
        const layout = buildLayout(posts, {minGap: 44, pixelsPerDay: 1.5});
        const svg = renderSvg(layout, {
            axisX: 180,
            width: 720,
            paddingTop: 40,
            paddingBottom: 24,
            maxArcWidth: 160,
            nodeRadius: 6,
            titleMaxLength: 32
        });
        const figure = document.createElement('div');
        figure.className = 'gh-strata-graph';
        figure.appendChild(svg);
        container.insertBefore(figure, list);
        list.hidden = true;
        container.classList.add('is-rendered');
    }

    window.HyperstrataGraph = {buildLayout: buildLayout};

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    }
})();
