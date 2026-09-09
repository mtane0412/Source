/**
 * Hyperstrata 引用グラフビュー
 *
 * サーバー側(Handlebars)が描画した記事一覧(data 属性に slug / 公開日 / 引用先 / 種別を持つ)を
 * 読み取り、SVG でグラフを描画する。外部ライブラリには依存しない。描画先は 2 種類ある。
 *
 * 1. custom-strata.hbs([data-strata]): 固定ページ用。縦軸を時間(公開日)としたアーク図(古い記事が上)
 * 2. partials/strata-pane.hbs([data-strata-pane]): 記事ページ・トップページ左側の固定ペイン。新しい記事が上、
 *    月ごとの区切り線付き。エッジは git のブランチ図のようにレーンを分けて描き、
 *    現在の記事(data-current-slug)とその引用チェーン(2 ホップ)を強調し、無関係なものは暗くする。
 *    トップページでは data-current-slug が空になり、中立モード(強調も暗転もなし)で描く
 *
 * - ノード: 記事。クリックで記事ページへ遷移する
 * - エッジ: 引用関係(引用元 → 引用先)。種別タグ(#correction 等)があれば線の見た目を変える
 * - JavaScript が無効な環境では元の記事一覧がそのまま表示される(有効時も支援技術向けに残す)
 *
 * レイアウト計算(buildLayout / buildPaneLayout / assignLanes / computeEmphasis)は DOM に依存しない
 * 純粋関数として window.HyperstrataGraph に公開し、scripts/strata-graph.test.mjs から検証する。
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
     * @param {{axisX: number, paddingTop: number, paddingBottom: number, width: number, maxArcWidth: number, nodeRadius: number, titleMaxLength: number, label: string}} options
     * @returns {SVGSVGElement}
     */
    function renderSvg(layout, options) {
        const height = layout.height + options.paddingTop + options.paddingBottom;
        const svg = createElement('svg', {
            class: 'gh-strata-svg',
            viewBox: '0 0 ' + options.width + ' ' + height,
            width: options.width,
            height: height,
            'aria-label': options.label
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

    /**
     * 行範囲が重なるエッジが同じレーンを使わないように、各エッジにレーン番号を割り当てる。
     *
     * 隣接する行(toRow - fromRow === 1)を結ぶエッジはノード列上の直線で描けるためレーン 0 とする。
     * それ以外は区間グラフの貪欲彩色で、レーン 1 以上のうち空いている最小の番号を使う。
     * 端の行だけを共有するエッジ(例: 0→2 と 2→4)は縦線が重ならないため同じレーンを再利用する。
     *
     * @param {Array<{fromRow: number, toRow: number}>} edges fromRow < toRow を満たすエッジ
     * @returns {object[]} 入力と同じ順序で lane を付与した新しい配列(入力は変更しない)
     */
    function assignLanes(edges) {
        const indexed = edges.map(function (edge, index) {
            return {edge: edge, index: index};
        });
        // 長いエッジを先に置いたほうが外側のレーンにまとまり、見た目が git グラフに近づく
        const order = indexed.filter(function (item) {
            return item.edge.toRow - item.edge.fromRow > 1;
        }).sort(function (a, b) {
            return a.edge.fromRow - b.edge.fromRow || (b.edge.toRow - b.edge.fromRow) - (a.edge.toRow - a.edge.fromRow);
        });
        /** レーン番号 → そのレーンに置かれたエッジの行範囲 */
        const laneRanges = [];
        const lanes = new Array(edges.length).fill(0);
        order.forEach(function (item) {
            let lane = 0;
            while (true) {
                lane += 1;
                const ranges = laneRanges[lane] || [];
                const overlaps = ranges.some(function (range) {
                    return item.edge.fromRow < range.toRow && range.fromRow < item.edge.toRow;
                });
                if (!overlaps) {
                    laneRanges[lane] = ranges.concat([{fromRow: item.edge.fromRow, toRow: item.edge.toRow}]);
                    break;
                }
            }
            lanes[item.index] = lane;
        });
        return edges.map(function (edge, index) {
            return Object.assign({}, edge, {lane: lanes[index]});
        });
    }

    /** 公開日(ローカル時刻)から月ラベル(YYYY-MM)を作る */
    function monthLabel(time) {
        const date = new Date(time);
        const month = date.getMonth() + 1;
        return date.getFullYear() + '-' + (month < 10 ? '0' : '') + month;
    }

    /**
     * 固定ペイン用のレイアウトを計算する。新しい記事を上(row 0)に並べ、行間は一定(rowHeight)、
     * 月が変わる位置に区切り(monthMarks)を置いて monthGap ぶん余白を空ける。
     *
     * @param {Array<{slug: string, title: string, url: string, publishedAt: string, refs: string[], kind: string}>} posts
     * @param {{rowHeight: number, monthGap: number, paddingTop: number, paddingBottom: number}} options
     * @returns {{nodes: object[], edges: object[], monthMarks: object[], laneCount: number, height: number}}
     */
    function buildPaneLayout(posts, options) {
        const sorted = posts
            .map(function (post) {
                const time = Date.parse(post.publishedAt);
                if (Number.isNaN(time)) {
                    throw new Error('公開日を解釈できません: ' + post.slug + ' (' + post.publishedAt + ')');
                }
                return Object.assign({}, post, {time: time});
            })
            .sort(function (a, b) {
                return b.time - a.time;
            });

        if (sorted.length === 0) {
            return {nodes: [], edges: [], monthMarks: [], laneCount: 0, height: 0};
        }

        const nodes = [];
        const monthMarks = [];
        const rowOf = {};
        let previousMonth = null;
        let y = options.paddingTop;

        sorted.forEach(function (post, row) {
            const month = monthLabel(post.time);
            if (month !== previousMonth) {
                // 区切りは月の最初のノードの上に置く
                monthMarks.push({label: month, y: y + options.monthGap / 2});
                y += options.monthGap;
                previousMonth = month;
            }
            y += row === 0 ? 0 : options.rowHeight;
            nodes.push({slug: post.slug, title: post.title, url: post.url, publishedAt: post.publishedAt, kind: post.kind, row: row, y: y});
            rowOf[post.slug] = row;
        });

        const rawEdges = [];
        sorted.forEach(function (post) {
            post.refs.forEach(function (ref) {
                if (Object.prototype.hasOwnProperty.call(rowOf, ref) && ref !== post.slug) {
                    const fromRow = rowOf[post.slug];
                    const toRow = rowOf[ref];
                    // 引用元は引用先より新しい(上にある)はずだが、同時刻などで逆転した場合も上→下に揃える
                    rawEdges.push({
                        from: post.slug,
                        to: ref,
                        kind: post.kind,
                        fromRow: Math.min(fromRow, toRow),
                        toRow: Math.max(fromRow, toRow)
                    });
                }
            });
        });
        const edges = assignLanes(rawEdges);
        const laneCount = edges.reduce(function (max, edge) {
            return Math.max(max, edge.lane);
        }, 0);

        return {nodes: nodes, edges: edges, monthMarks: monthMarks, laneCount: laneCount, height: y + options.paddingBottom};
    }

    /**
     * 現在の記事から引用の向きを問わず maxHops ホップ以内にあるノード・エッジの距離を求める。
     *
     * @param {Array<{from: string, to: string}>} edges
     * @param {string} currentSlug
     * @param {number} maxHops
     * @returns {{neutral: boolean, nodes: Object<string, number>, edges: Array<number|null>}} nodes は到達したノードの距離、
     *   edges は入力順のエッジ距離(両端ノードの近いほうの距離 + 1。到達しない場合は -1)。
     *   currentSlug が空(トップページなど現在記事が無い場合)は中立モード(neutral: true)となり、
     *   nodes は空、edges はすべて null で、何も強調せず何も暗くしない
     */
    function computeEmphasis(edges, currentSlug, maxHops) {
        if (!currentSlug) {
            return {
                neutral: true,
                nodes: {},
                edges: edges.map(function () {
                    return null;
                })
            };
        }
        const neighbors = {};
        let known = false;
        edges.forEach(function (edge) {
            (neighbors[edge.from] = neighbors[edge.from] || []).push(edge.to);
            (neighbors[edge.to] = neighbors[edge.to] || []).push(edge.from);
            if (edge.from === currentSlug || edge.to === currentSlug) {
                known = true;
            }
        });
        const distance = {};
        if (known) {
            distance[currentSlug] = 0;
            const queue = [currentSlug];
            while (queue.length > 0) {
                const slug = queue.shift();
                if (distance[slug] >= maxHops) {
                    continue;
                }
                neighbors[slug].forEach(function (next) {
                    if (!Object.prototype.hasOwnProperty.call(distance, next)) {
                        distance[next] = distance[slug] + 1;
                        queue.push(next);
                    }
                });
            }
        }
        const edgeDistances = edges.map(function (edge) {
            const candidates = [edge.from, edge.to].filter(function (slug) {
                return Object.prototype.hasOwnProperty.call(distance, slug);
            }).map(function (slug) {
                return distance[slug] + 1;
            });
            if (candidates.length === 0) {
                return -1;
            }
            const value = Math.min.apply(null, candidates);
            return value > maxHops ? -1 : value;
        });
        return {neutral: false, nodes: distance, edges: edgeDistances};
    }

    /**
     * ペイン用エッジのパスを作る。引用元ノードからレーンへ曲線で出て、レーン上を縦に下り、
     * 引用先ノードへ曲線で戻る(git のブランチ図の見た目)。レーン 0 は直線。
     */
    function paneEdgePath(edge, nodeY, options) {
        const x0 = options.axisX;
        const fromY = nodeY[edge.from];
        const toY = nodeY[edge.to];
        const top = Math.min(fromY, toY);
        const bottom = Math.max(fromY, toY);
        if (edge.lane === 0) {
            return 'M ' + x0 + ' ' + top + ' L ' + x0 + ' ' + bottom;
        }
        const x = x0 + edge.lane * options.laneWidth;
        const bend = options.rowHeight;
        // 制御点を縦方向の中間に置き、行き過ぎのない滑らかな S 字でレーンへ出入りする
        const half = bend / 2;
        return 'M ' + x0 + ' ' + top +
            ' C ' + x0 + ' ' + (top + half) + ' ' + x + ' ' + (top + half) + ' ' + x + ' ' + (top + bend) +
            ' L ' + x + ' ' + (bottom - bend) +
            ' C ' + x + ' ' + (bottom - half) + ' ' + x0 + ' ' + (bottom - half) + ' ' + x0 + ' ' + bottom;
    }

    /** 距離に応じた強調クラス名を返す(0: 現在記事、1: 直接の引用、2: 2 ホップ、-1: 無関係、null: 中立モードで強調なし) */
    function emphasisClass(distance) {
        if (distance === null) {
            return '';
        }
        if (distance < 0) {
            return ' is-dim';
        }
        return ' is-level-' + distance;
    }

    /**
     * 固定ペイン用のレイアウトを SVG として描画する。
     *
     * @param {ReturnType<typeof buildPaneLayout>} layout
     * @param {ReturnType<typeof computeEmphasis>} emphasis
     * @param {{axisX: number, laneWidth: number, rowHeight: number, width: number, nodeRadius: number, label: string, dateLocale: string}} options
     */
    function renderPaneSvg(layout, emphasis, options) {
        const svg = createElement('svg', {
            class: 'gh-strata-pane-svg',
            viewBox: '0 0 ' + options.width + ' ' + layout.height,
            width: options.width,
            height: layout.height,
            'aria-label': options.label
        });
        const nodeY = {};
        layout.nodes.forEach(function (node) {
            nodeY[node.slug] = node.y;
        });

        // 月の区切り線とラベル(ラベルは右端に寄せる)
        const monthGroup = createElement('g', {class: 'gh-strata-pane-months'});
        layout.monthMarks.forEach(function (mark) {
            monthGroup.appendChild(createElement('line', {
                class: 'gh-strata-pane-month-line',
                x1: 0, y1: mark.y, x2: options.width, y2: mark.y
            }));
            const label = createElement('text', {
                class: 'gh-strata-pane-month-label',
                x: options.width - 8,
                y: mark.y - 4
            });
            label.textContent = mark.label;
            monthGroup.appendChild(label);
        });
        svg.appendChild(monthGroup);

        // エッジ。強調するものが上に重なるように、無関係 → 遠い → 近い の順で追加する
        const edgeGroup = createElement('g', {class: 'gh-strata-pane-edges'});
        layout.edges.map(function (edge, index) {
            return {edge: edge, distance: emphasis.edges[index]};
        }).sort(function (a, b) {
            const rank = function (distance) {
                return distance === null || distance < 0 ? Infinity : distance;
            };
            return rank(b.distance) - rank(a.distance);
        }).forEach(function (item) {
            edgeGroup.appendChild(createElement('path', {
                class: 'gh-strata-pane-edge' + (item.edge.kind ? ' is-' + item.edge.kind : '') + emphasisClass(item.distance),
                d: paneEdgePath(item.edge, nodeY, options),
                'data-from': item.edge.from,
                'data-to': item.edge.to
            }));
        });
        svg.appendChild(edgeGroup);

        // ノード。<a> で包み、<title> でタイトルと公開日をツールチップ表示する
        const nodeGroup = createElement('g', {class: 'gh-strata-pane-nodes'});
        layout.nodes.forEach(function (node) {
            // 中立モード(トップページ)では全ノードを標準色で描き、現在記事の輪も付けない
            const distance = emphasis.neutral ? null :
                (Object.prototype.hasOwnProperty.call(emphasis.nodes, node.slug) ? emphasis.nodes[node.slug] : -1);
            const anchor = createElement('a', {
                class: 'gh-strata-pane-node' + emphasisClass(distance),
                href: node.url,
                'data-slug': node.slug
            });
            if (distance === 0) {
                anchor.setAttribute('aria-current', 'page');
            }
            const tooltip = createElement('title', {});
            tooltip.textContent = node.title + ' (' + new Date(node.publishedAt).toLocaleDateString(options.dateLocale) + ')';
            anchor.appendChild(tooltip);
            if (distance === 0) {
                // 現在の記事には輪をつける
                anchor.appendChild(createElement('circle', {
                    class: 'gh-strata-pane-ring',
                    cx: options.axisX, cy: node.y, r: options.nodeRadius + 4
                }));
            }
            anchor.appendChild(createElement('circle', {
                class: 'gh-strata-pane-dot' + (node.kind ? ' is-' + node.kind : ''),
                cx: options.axisX, cy: node.y, r: options.nodeRadius
            }));
            nodeGroup.appendChild(anchor);
        });
        svg.appendChild(nodeGroup);
        return svg;
    }

    /** ペインの開閉(狭い画面向け)。aria-expanded と is-open クラスを同期する */
    function setupPaneToggle(pane) {
        const toggle = pane.querySelector('[data-strata-toggle]');
        if (!toggle) {
            return;
        }
        toggle.addEventListener('click', function () {
            const open = !pane.classList.contains('is-open');
            pane.classList.toggle('is-open', open);
            toggle.setAttribute('aria-expanded', String(open));
        });
    }

    /** 記事ページ・トップページ左側の固定ペインを初期化する(data-current-slug が空ならトップページとして中立モードで描く) */
    function initPane() {
        const pane = document.querySelector('[data-strata-pane]');
        if (!pane) {
            return;
        }
        setupPaneToggle(pane);
        const list = pane.querySelector('[data-strata-list]');
        const posts = readPostsFromList(list);
        if (posts.length === 0) {
            return;
        }
        const rowHeight = 26;
        const layout = buildPaneLayout(posts, {rowHeight: rowHeight, monthGap: 30, paddingTop: 24, paddingBottom: 48});
        const emphasis = computeEmphasis(layout.edges, pane.dataset.currentSlug || '', 2);
        const svg = renderPaneSvg(layout, emphasis, {
            axisX: 24,
            laneWidth: 12,
            rowHeight: rowHeight,
            width: 24 + (layout.laneCount + 1) * 12 + 72,
            nodeRadius: 4,
            label: pane.dataset.strataLabel || '',
            dateLocale: document.documentElement.lang || undefined
        });
        const scroll = pane.querySelector('[data-strata-scroll]');
        scroll.insertBefore(svg, list);
        list.classList.add('is-sr-only');
        pane.classList.add('is-rendered');

        // 現在の記事がペインの中央に来るようにスクロールしておく
        const current = layout.nodes.filter(function (node) {
            return node.slug === pane.dataset.currentSlug;
        })[0];
        if (current) {
            scroll.scrollTop = Math.max(0, current.y - scroll.clientHeight / 2);
        }
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
            titleMaxLength: 32,
            label: container.dataset.strataLabel || ''
        });
        const figure = document.createElement('div');
        figure.className = 'gh-strata-graph';
        figure.appendChild(svg);
        container.insertBefore(figure, list);
        // 一覧は支援技術向けに残しつつ視覚的には非表示にする
        list.classList.add('is-sr-only');
        container.classList.add('is-rendered');
    }

    window.HyperstrataGraph = {
        buildLayout: buildLayout,
        buildPaneLayout: buildPaneLayout,
        assignLanes: assignLanes,
        computeEmphasis: computeEmphasis
    };

    if (typeof document !== 'undefined') {
        const start = function () {
            init();
            initPane();
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', start);
        } else {
            start();
        }
    }
})();
