/**
 * Hyperstrata 引用グラフビュー
 *
 * scripts/hyperstrata-sync.mjs が生成する assets/graph.json(公開記事の slug / タイトル / URL / 公開日 / 引用先)を
 * fetch で読み取り、SVG でグラフを描画する。外部ライブラリには依存しない。描画先は 2 種類ある。
 * graph.json の URL はテンプレートが data-strata-graph-url({{asset "graph.json"}})で渡す。
 * 本文の表示を優先するため、初期化は requestIdleCallback で遅らせ、fetch は低優先度で行う。
 *
 * 1. custom-strata.hbs([data-strata]): 固定ページ用。縦軸を時間(公開日)としたアーク図(新しい記事が上)。
 *    年ごとの帯を地層として塗り分け、引用の線は古い層へ伸びる根として左に膨らむ弧で描く
 * 2. partials/strata-pane.hbs([data-strata-pane]): 記事ページ・トップページ左側の固定ペイン。新しい記事が上、
 *    月ごとの区切り線付き。記事ごとに列(col)を持ち、引用チェーンが同じ列を継いで 1 本の幹になり、
 *    複数の引用で枝分かれ、複数からの被引用で合流する git のブランチ図のように描く(本家 Hyperstrata と同じ方式)。
 *    現在の記事(data-current-slug)とその引用チェーン(2 ホップ)を強調し、無関係なものは暗くする。
 *    引用の無い孤立した記事でも、現在記事であれば強調する。
 *    トップページでは data-current-slug が空になり、中立モード(強調も暗転もなし)で描く。
 *    見た目は「地層(strata)の中を種と根が伸びる」イメージ: 月ごとの帯を地層として塗り分け(古いほど深く濃い)、
 *    境界は波線、記事は種(楕円)、現在記事は芽吹いた種、引用の線は古い層へ伸びる根として描く。
 *    種にマウスを乗せると HTML のツールチップでタイトルと公開日を表示する
 *
 * - ノード: 記事。クリックで記事ページへ遷移する(支援技術向けの名前は aria-label で与える)
 * - エッジ: 引用関係(引用元 → 引用先)
 * - graph.json の取得や内容の検証に失敗した場合は console.error に出力し、グラフは描画しない
 *
 * レイアウト計算(buildLayout / buildPaneLayout / assignColumns / computeEmphasis / buildStrataBands / strataBoundaryPath)と
 * graph.json の検証(parseGraph)は DOM に依存しない純粋関数として window.HyperstrataGraph に公開し、
 * scripts/strata-graph.test.mjs から検証する。
 */
(function () {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const MS_PER_DAY = 24 * 60 * 60 * 1000;

    /**
     * 記事一覧からグラフのレイアウト(ノード座標・エッジ・年の区切り)を計算する。
     *
     * 新しい記事を上(地表)、古い記事を下(深い層)に置く。y 座標は最新記事からの経過日数 × pixelsPerDay を
     * 基本とし、隣接ノードとの間隔が minGap を下回る場合は minGap まで押し下げる
     * (同日公開の記事が重ならないようにするため)。yearMarks は年ごとの地層の上端(その年で最も新しいノードの位置)。
     *
     * @param {Array<{slug: string, title: string, url: string, publishedAt: string, refs: string[]}>} posts
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
                return b.time - a.time;
            });

        if (sorted.length === 0) {
            return {nodes: [], edges: [], yearMarks: [], height: 0};
        }

        const nodes = [];
        const yearMarks = [];
        const newestTime = sorted[0].time;
        let previousY = -Infinity;
        let previousYear = null;

        sorted.forEach(function (post) {
            const scaledY = ((newestTime - post.time) / MS_PER_DAY) * options.pixelsPerDay;
            const y = Math.max(scaledY, previousY + options.minGap);
            const year = new Date(post.time).getFullYear();
            if (year !== previousYear) {
                yearMarks.push({year: year, y: y});
                previousYear = year;
            }
            nodes.push({slug: post.slug, title: post.title, url: post.url, publishedAt: post.publishedAt, y: y});
            previousY = y;
        });

        const slugs = new Set(nodes.map(function (node) {
            return node.slug;
        }));
        const edges = [];
        sorted.forEach(function (post) {
            post.refs.forEach(function (ref) {
                if (slugs.has(ref) && ref !== post.slug) {
                    edges.push({from: post.slug, to: ref});
                }
            });
        });

        return {nodes: nodes, edges: edges, yearMarks: yearMarks, height: previousY};
    }

    /**
     * graph.json の内容を検証し、記事配列を取り出す。
     *
     * 必須項目(slug / title / url / publishedAt / refs)が欠けたデータは、描画途中で分かりにくく壊れるより
     * ここで例外にして早期に失敗させる。
     *
     * @param {unknown} data graph.json をパースした値
     * @returns {Array<{slug: string, title: string, url: string, publishedAt: string, refs: string[]}>}
     */
    function parseGraph(data) {
        if (!data || !Array.isArray(data.posts)) {
            throw new Error('graph.json に posts 配列がありません');
        }
        const stringFields = ['slug', 'title', 'url', 'publishedAt'];
        data.posts.forEach(function (post, index) {
            stringFields.forEach(function (field) {
                if (typeof post[field] !== 'string') {
                    throw new Error('graph.json の posts[' + index + '] に ' + field + ' がありません');
                }
            });
            if (!Array.isArray(post.refs)) {
                throw new Error('graph.json の posts[' + index + '] に refs 配列がありません');
            }
        });
        return data.posts;
    }

    /**
     * graph.json を低優先度で取得して記事配列を返す。
     *
     * @param {string} url テンプレートが data-strata-graph-url で渡す graph.json の URL
     * @returns {Promise<Array<object>>}
     */
    function loadGraph(url) {
        if (!url) {
            return Promise.reject(new Error('data-strata-graph-url が設定されていません'));
        }
        return fetch(url, {priority: 'low'}).then(function (response) {
            if (!response.ok) {
                throw new Error('graph.json の取得に失敗しました: ' + response.status + ' ' + url);
            }
            return response.json();
        }).then(parseGraph);
    }

    function createElement(name, attributes) {
        const element = document.createElementNS(SVG_NS, name);
        Object.keys(attributes).forEach(function (key) {
            element.setAttribute(key, attributes[key]);
        });
        return element;
    }

    /** 表示用にタイトルを一定文字数で切り詰める(全文は aria-label に持たせる) */
    function truncate(text, maxLength) {
        return text.length > maxLength ? text.slice(0, maxLength - 1) + '…' : text;
    }

    /**
     * レイアウトを SVG として描画する。
     *
     * @param {ReturnType<typeof buildLayout>} layout
     * ペインと同じ「地層の中を種と根が伸びる」デザイン: 年ごとの帯を地層として塗り分け(古い年ほど深く濃い)、
     * 境界は波線、記事は種(楕円)、引用の線は古い層へ伸びる根(左に膨らむ弧)として描く。
     *
     * @param {{axisX: number, paddingTop: number, paddingBottom: number, width: number, maxArcWidth: number, nodeRadius: number, maxDepthShade: number, titleMaxLength: number, label: string}} options
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

        // 地層の帯(年ごと)。境界はその年で最も新しいノードの少し上に置く
        const yearMarks = layout.yearMarks.map(function (mark) {
            return {label: String(mark.year), y: mark.y + options.paddingTop - options.nodeRadius * 3};
        });
        const bandGroup = createElement('g', {class: 'gh-strata-strata'});
        buildStrataBands(yearMarks, height).forEach(function (band) {
            bandGroup.appendChild(createElement('rect', {
                class: 'gh-strata-stratum',
                x: 0, y: band.top, width: options.width, height: band.bottom - band.top,
                'data-depth': String(Math.min(band.depth, options.maxDepthShade))
            }));
        });
        svg.appendChild(bandGroup);

        // 地層の境界線(波線)と年ラベル。ラベルは時間軸のすぐ右・境界線の上に置く
        // (右端に寄せると狭い画面で横スクロールしないと見えなくなるため)
        const yearGroup = createElement('g', {class: 'gh-strata-years'});
        yearMarks.forEach(function (mark, index) {
            yearGroup.appendChild(createElement('path', {
                class: 'gh-strata-year-line',
                d: strataBoundaryPath(mark.y, options.width, {amplitude: 3, wavelength: 48, phase: index})
            }));
            const label = createElement('text', {
                class: 'gh-strata-year',
                x: options.axisX + options.nodeRadius * 2 + 4,
                y: mark.y - 6
            });
            label.textContent = mark.label;
            yearGroup.appendChild(label);
        });
        svg.appendChild(yearGroup);

        // 時間軸(地表から深部へ下りる細い線)
        svg.appendChild(createElement('line', {
            class: 'gh-strata-axis',
            x1: options.axisX, y1: options.paddingTop - options.nodeRadius * 2,
            x2: options.axisX, y2: height - options.paddingBottom + options.nodeRadius * 2
        }));

        // エッジ(引用元 → 引用先)。新しい記事から古い層へ伸びる根として、時間軸の左側に楕円弧で描く
        const edgeGroup = createElement('g', {class: 'gh-strata-edges'});
        layout.edges.forEach(function (edge) {
            const fromY = nodeY[edge.from];
            const toY = nodeY[edge.to];
            const ry = Math.abs(fromY - toY) / 2;
            const rx = Math.min(ry, options.maxArcWidth);
            // 引用元(新しい記事)から引用先(古い記事)へ、左に膨らむ弧を描く
            const sweep = fromY > toY ? 1 : 0;
            const path = createElement('path', {
                class: 'gh-strata-edge',
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
            const anchor = createElement('a', {class: 'gh-strata-node', href: node.url, 'data-slug': node.slug, 'aria-label': node.title});
            // 記事は「種」の形(縦長の楕円)で描く
            anchor.appendChild(createElement('ellipse', {
                class: 'gh-strata-dot',
                cx: options.axisX, cy: y, rx: options.nodeRadius, ry: options.nodeRadius * 1.3
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
     * 記事ごとに列(col)を割り当てる(git のブランチ図方式)。列は 0 を中心とした符号付き整数で、
     * 必要になった順に 0, +1, -1, +2, -2, … と外側へ広げる。
     *
     * 新しい記事(row 0)から順に処理し、次の規則で決める。
     * - 列が未定の記事(まだ誰にも引用されていない起点・孤立記事)は、その行で空いている 0 に最も近い列に置く
     * - 記事が引用する相手を近い(新しい)順に見て、列が未定なら引用元の列を継がせる(幹が続く)。
     *   途中の行がすでに別の幹に使われていれば、引用元の列に最も近い空き列に置く(枝分かれ)
     * - 引用先がすでに列を持っていれば何もしない(その幹へ合流する線になる)
     * 幹の区間(引用元の次の行から引用先の行まで)は列の占有として記録し、他の記事や幹が重ならないようにする。
     *
     * @param {Array<{slug: string, row: number}>} nodes 行順(新しい順)のノード
     * @param {Array<{fromRow: number, toRow: number}>} edges fromRow < toRow のエッジ
     * @returns {{cols: number[], minCol: number, maxCol: number}} cols はノードと同じ順の列番号。ノードが無ければ 0..0
     */
    function assignColumns(nodes, edges) {
        const indexOfRow = {};
        nodes.forEach(function (node, index) {
            indexOfRow[node.row] = index;
        });
        const cols = nodes.map(function () {
            return null;
        });
        /** 列番号 → 占有している行区間(両端を含む)の配列 */
        const reserved = {};
        const isFree = function (col, fromRow, toRow) {
            return (reserved[col] || []).every(function (range) {
                return toRow < range.fromRow || range.toRow < fromRow;
            });
        };
        const reserve = function (col, fromRow, toRow) {
            (reserved[col] = reserved[col] || []).push({fromRow: fromRow, toRow: toRow});
        };
        /** center から外側へ向かって、行区間が空いている最初の列を返す */
        const nearestFree = function (center, fromRow, toRow) {
            for (let offset = 0; ; offset += 1) {
                const candidates = offset === 0 ? [center] : [center + offset, center - offset];
                for (let i = 0; i < candidates.length; i += 1) {
                    if (isFree(candidates[i], fromRow, toRow)) {
                        return candidates[i];
                    }
                }
            }
        };
        const outgoing = nodes.map(function () {
            return [];
        });
        edges.forEach(function (edge) {
            outgoing[indexOfRow[edge.fromRow]].push(edge);
        });

        nodes.forEach(function (node, index) {
            if (cols[index] === null) {
                cols[index] = nearestFree(0, node.row, node.row);
                reserve(cols[index], node.row, node.row);
            }
            const col = cols[index];
            outgoing[index].slice().sort(function (a, b) {
                return a.toRow - b.toRow;
            }).forEach(function (edge) {
                const targetIndex = indexOfRow[edge.toRow];
                if (cols[targetIndex] !== null) {
                    return;
                }
                const targetCol = nearestFree(col, node.row + 1, edge.toRow);
                cols[targetIndex] = targetCol;
                reserve(targetCol, node.row + 1, edge.toRow);
            });
        });

        const minCol = cols.reduce(function (min, col) {
            return Math.min(min, col);
        }, 0);
        const maxCol = cols.reduce(function (max, col) {
            return Math.max(max, col);
        }, 0);
        return {cols: cols, minCol: minCol, maxCol: maxCol};
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
     * @param {Array<{slug: string, title: string, url: string, publishedAt: string, refs: string[]}>} posts
     * @param {{rowHeight: number, monthGap: number, paddingTop: number, paddingBottom: number}} options
     * @returns {{nodes: object[], edges: object[], monthMarks: object[], minCol: number, maxCol: number, height: number}}
     *   nodes は col(列番号)、edges は fromCol / toCol(両端の列番号)を持つ
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
            return {nodes: [], edges: [], monthMarks: [], minCol: 0, maxCol: 0, height: 0};
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
            nodes.push({slug: post.slug, title: post.title, url: post.url, publishedAt: post.publishedAt, row: row, y: y});
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
                        fromRow: Math.min(fromRow, toRow),
                        toRow: Math.max(fromRow, toRow)
                    });
                }
            });
        });
        const columns = assignColumns(nodes, rawEdges);
        nodes.forEach(function (node, index) {
            node.col = columns.cols[index];
        });
        const edges = rawEdges.map(function (edge) {
            return Object.assign({}, edge, {fromCol: columns.cols[edge.fromRow], toCol: columns.cols[edge.toRow]});
        });

        return {nodes: nodes, edges: edges, monthMarks: monthMarks, minCol: columns.minCol, maxCol: columns.maxCol, height: y + options.paddingBottom};
    }

    /**
     * 現在の記事から引用の向きを問わず maxHops ホップ以内にあるノード・エッジの距離を求める。
     *
     * 現在記事の存在はノード一覧で判定する。引用が一本も無い孤立した記事でも、ノードとして存在すれば
     * 距離 0(現在記事)として強調され、他のノード・エッジはすべて暗くなる。
     *
     * @param {Array<{slug: string}>} nodes グラフ上の全ノード
     * @param {Array<{from: string, to: string}>} edges
     * @param {string} currentSlug
     * @param {number} maxHops
     * @returns {{neutral: boolean, nodes: Object<string, number>, edges: Array<number|null>}} nodes は到達したノードの距離、
     *   edges は入力順のエッジ距離(両端ノードの近いほうの距離 + 1。到達しない場合は -1)。
     *   currentSlug が空(トップページなど現在記事が無い場合)は中立モード(neutral: true)となり、
     *   nodes は空、edges はすべて null で、何も強調せず何も暗くしない
     */
    function computeEmphasis(nodes, edges, currentSlug, maxHops) {
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
        const known = nodes.some(function (node) {
            return node.slug === currentSlug;
        });
        edges.forEach(function (edge) {
            (neighbors[edge.from] = neighbors[edge.from] || []).push(edge.to);
            (neighbors[edge.to] = neighbors[edge.to] || []).push(edge.from);
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
                (neighbors[slug] || []).forEach(function (next) {
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

    /** 列番号を SVG の x 座標に変換する(列 0 が axisX) */
    function columnX(col, options) {
        return options.axisX + col * options.laneWidth;
    }

    /**
     * ペイン用エッジのパスを作る。両端が同じ列なら幹として直線で結ぶ。列が違う場合は、上のノードから
     * 1 行ぶんの S 字で相手の列へ移り、そのまま縦に下って下のノードへ届く(git のブランチ図の枝分かれ・合流の見た目)。
     * ノード座標は nodeY(slug → y)から引き、fromRow < toRow に揃えてあるため fromCol が上、toCol が下になる。
     */
    function paneEdgePath(edge, nodeY, options) {
        const xTop = columnX(edge.fromCol, options);
        const xBottom = columnX(edge.toCol, options);
        const top = Math.min(nodeY[edge.from], nodeY[edge.to]);
        const bottom = Math.max(nodeY[edge.from], nodeY[edge.to]);
        if (xTop === xBottom) {
            return 'M ' + xTop + ' ' + top + ' L ' + xTop + ' ' + bottom;
        }
        const bend = options.rowHeight;
        // 制御点を縦方向の中間に置き、行き過ぎのない滑らかな S 字で相手の列へ移る
        const half = bend / 2;
        return 'M ' + xTop + ' ' + top +
            ' C ' + xTop + ' ' + (top + half) + ' ' + xBottom + ' ' + (top + half) + ' ' + xBottom + ' ' + (top + bend) +
            ' L ' + xBottom + ' ' + bottom;
    }

    /**
     * 月の区切り(monthMarks)の間を「地層」の帯として切り出す。上の帯ほど新しく(浅く)、
     * 下の帯ほど古い(深い)。depth は上から 0, 1, 2, … と増え、CSS で深さに応じた色の濃さに使う。
     *
     * @param {Array<{label: string, y: number}>} monthMarks 上から順に並んだ月の区切り
     * @param {number} height SVG 全体の高さ(最後の帯の下端)
     * @returns {Array<{label: string, top: number, bottom: number, depth: number}>}
     */
    function buildStrataBands(monthMarks, height) {
        return monthMarks.map(function (mark, index) {
            const next = monthMarks[index + 1];
            return {
                label: mark.label,
                top: mark.y,
                bottom: next ? next.y : height,
                depth: index
            };
        });
    }

    /**
     * 地層の境界線を、まっすぐな直線ではなく緩やかにうねる波線のパスとして作る。
     * 二次ベジェ曲線を wavelength ごとに上下交互に膨らませて繋ぐ。
     * phase(0 以上の整数)で膨らみの向きをずらし、隣り合う境界線が同じ形にならないようにする。
     *
     * @param {number} y 境界線の基準となる y 座標
     * @param {number} width 線の右端(x)
     * @param {{amplitude: number, wavelength: number, phase?: number}} options
     * @returns {string} SVG path の d 属性
     */
    function strataBoundaryPath(y, width, options) {
        const phase = options.phase || 0;
        let d = 'M 0 ' + y;
        let x = 0;
        let index = 0;
        while (x < width) {
            const nextX = Math.min(x + options.wavelength, width);
            const direction = (index + phase) % 2 === 0 ? -1 : 1;
            const controlX = x + (nextX - x) / 2;
            d += ' Q ' + controlX + ' ' + (y + direction * options.amplitude) + ' ' + nextX + ' ' + y;
            x = nextX;
            index += 1;
        }
        return d;
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
     * 現在記事の種から伸びる「芽」(茎と双葉)のパスを作る。baseY は種の上端、size は芽の高さ。
     *
     * @param {number} x 茎の x 座標
     * @param {number} baseY 芽の付け根の y 座標
     * @param {number} size 芽の高さ(px)
     * @returns {string} SVG path の d 属性
     */
    function sproutPath(x, baseY, size) {
        const topY = baseY - size;
        const leaf = size * 0.55;
        return 'M ' + x + ' ' + baseY + ' L ' + x + ' ' + topY +
            ' M ' + x + ' ' + (topY + leaf * 0.6) +
            ' Q ' + (x - leaf) + ' ' + (topY + leaf * 0.5) + ' ' + (x - leaf * 0.9) + ' ' + (topY - leaf * 0.35) +
            ' Q ' + (x - leaf * 0.2) + ' ' + (topY - leaf * 0.1) + ' ' + x + ' ' + (topY + leaf * 0.6) +
            ' M ' + x + ' ' + (topY + leaf * 0.2) +
            ' Q ' + (x + leaf) + ' ' + (topY + leaf * 0.1) + ' ' + (x + leaf * 0.9) + ' ' + (topY - leaf * 0.75) +
            ' Q ' + (x + leaf * 0.2) + ' ' + (topY - leaf * 0.5) + ' ' + x + ' ' + (topY + leaf * 0.2);
    }

    /**
     * 固定ペイン用のレイアウトを SVG として描画する。
     *
     * @param {ReturnType<typeof buildPaneLayout>} layout
     * @param {ReturnType<typeof computeEmphasis>} emphasis
     * @param {{axisX: number, laneWidth: number, rowHeight: number, width: number, nodeRadius: number, maxDepthShade: number, bleed: number, label: string, dateLocale: string}} options
     *   axisX は列 0 の x 座標、laneWidth は列の間隔(px)。maxDepthShade は地層の色の濃さの段階数の上限(CSS の data-depth と一致させる)、bleed は地層をペイン端まで届かせるための左右のはみ出し幅(px)
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

        // 地層の帯。月ごとの区切りの間を塗り分け、深い(古い)層ほど濃くする(色は CSS の data-depth で決める)。
        // SVG はペイン中央に置かれるため、帯と境界線は bleed ぶん左右にはみ出させてペインの端まで届かせる
        // (SVG は overflow: visible、ペインのスクロール領域が overflow-x: hidden で切り取る)
        const bleedWidth = options.width + options.bleed * 2;
        const bandGroup = createElement('g', {class: 'gh-strata-pane-strata', transform: 'translate(' + (-options.bleed) + ' 0)'});
        buildStrataBands(layout.monthMarks, layout.height).forEach(function (band) {
            bandGroup.appendChild(createElement('rect', {
                class: 'gh-strata-pane-stratum',
                x: 0, y: band.top, width: bleedWidth, height: band.bottom - band.top,
                'data-depth': String(Math.min(band.depth, options.maxDepthShade))
            }));
        });
        svg.appendChild(bandGroup);

        // 地層の境界線(緩やかな波線)とラベル(ラベルは右端に寄せる)
        const monthGroup = createElement('g', {class: 'gh-strata-pane-months'});
        layout.monthMarks.forEach(function (mark, index) {
            monthGroup.appendChild(createElement('path', {
                class: 'gh-strata-pane-month-line',
                transform: 'translate(' + (-options.bleed) + ' 0)',
                d: strataBoundaryPath(mark.y, bleedWidth, {amplitude: 2.5, wavelength: 36, phase: index})
            }));
            const label = createElement('text', {
                class: 'gh-strata-pane-month-label',
                x: options.width - 8,
                y: mark.y - 5
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
                class: 'gh-strata-pane-edge' + emphasisClass(item.distance),
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
            // ツールチップは HTML 側(showTooltip)で出すため、支援技術向けの名前は aria-label で与える
            const dateText = new Date(node.publishedAt).toLocaleDateString(options.dateLocale);
            anchor.setAttribute('aria-label', node.title + ' (' + dateText + ')');
            anchor.setAttribute('data-title', node.title);
            anchor.setAttribute('data-date', dateText);
            const x = columnX(node.col, options);
            if (distance === 0) {
                // 現在の記事は「芽吹いた種」として、輪と芽(茎と双葉)をつける
                anchor.appendChild(createElement('circle', {
                    class: 'gh-strata-pane-ring',
                    cx: x, cy: node.y, r: options.nodeRadius + 4
                }));
                anchor.appendChild(createElement('path', {
                    class: 'gh-strata-pane-sprout',
                    d: sproutPath(x, node.y - options.nodeRadius - 4, options.nodeRadius * 2.5)
                }));
            }
            // ノードは「種」の形(縦長の楕円)で描く
            anchor.appendChild(createElement('ellipse', {
                class: 'gh-strata-pane-dot',
                cx: x, cy: node.y, rx: options.nodeRadius, ry: options.nodeRadius * 1.3
            }));
            nodeGroup.appendChild(anchor);
        });
        svg.appendChild(nodeGroup);
        return svg;
    }

    /**
     * ノード(種)にマウスを乗せた・フォーカスしたときに、記事のタイトルと公開日を HTML のツールチップで表示する。
     * SVG の <title> は表示までの遅延が長く狭いペインでは読みづらいため、ペイン内に絶対配置した要素を使う。
     * ツールチップはペインの座標系(fixed)に対して置くため、スクロール領域に切り取られない。
     */
    function setupTooltip(pane, svg) {
        const tooltip = document.createElement('div');
        tooltip.className = 'gh-strata-pane-tooltip';
        tooltip.setAttribute('role', 'tooltip');
        tooltip.hidden = true;
        const title = document.createElement('span');
        title.className = 'gh-strata-pane-tooltip-title';
        const date = document.createElement('span');
        date.className = 'gh-strata-pane-tooltip-date';
        tooltip.appendChild(title);
        tooltip.appendChild(date);
        pane.appendChild(tooltip);

        const show = function (anchor) {
            title.textContent = anchor.getAttribute('data-title');
            date.textContent = anchor.getAttribute('data-date');
            const dot = anchor.querySelector('.gh-strata-pane-dot');
            const dotRect = dot.getBoundingClientRect();
            const paneRect = pane.getBoundingClientRect();
            tooltip.hidden = false;
            tooltip.style.left = (dotRect.right - paneRect.left + 10) + 'px';
            // ツールチップの縦中央を種に合わせる(表示後に高さが確定するので hidden 解除後に計算する)
            const top = dotRect.top + dotRect.height / 2 - paneRect.top - tooltip.offsetHeight / 2;
            tooltip.style.top = Math.max(4, Math.min(top, paneRect.height - tooltip.offsetHeight - 4)) + 'px';
        };
        const hide = function () {
            tooltip.hidden = true;
        };
        Array.from(svg.querySelectorAll('.gh-strata-pane-node')).forEach(function (anchor) {
            anchor.addEventListener('mouseenter', function () {
                show(anchor);
            });
            anchor.addEventListener('focus', function () {
                show(anchor);
            });
            anchor.addEventListener('mouseleave', hide);
            anchor.addEventListener('blur', hide);
        });
        // スクロール中は位置がずれるので隠す
        pane.querySelector('[data-strata-scroll]').addEventListener('scroll', hide, {passive: true});
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
        loadGraph(pane.dataset.strataGraphUrl).then(function (posts) {
            renderPane(pane, posts);
        }).catch(function (error) {
            console.error('[Hyperstrata] 引用グラフペインを描画できません:', error);
        });
    }

    /** 取得した記事配列からペインの SVG を描画してスクロール領域に挿入する */
    function renderPane(pane, posts) {
        if (posts.length === 0) {
            return;
        }
        const rowHeight = 26;
        const layout = buildPaneLayout(posts, {rowHeight: rowHeight, monthGap: 30, paddingTop: 24, paddingBottom: 48});
        const emphasis = computeEmphasis(layout.nodes, layout.edges, pane.dataset.currentSlug || '', 2);
        const laneWidth = 12;
        const padding = 24;
        // 列 0 を中心に左右へ広がるため、最も左の列が padding の位置に来るように列 0 の x を決める
        const svg = renderPaneSvg(layout, emphasis, {
            axisX: padding - layout.minCol * laneWidth,
            laneWidth: laneWidth,
            rowHeight: rowHeight,
            width: padding + (layout.maxCol - layout.minCol + 1) * laneWidth + 72,
            nodeRadius: 4,
            maxDepthShade: 6,
            bleed: 400,
            label: pane.dataset.strataLabel || '',
            dateLocale: document.documentElement.lang || undefined
        });
        const scroll = pane.querySelector('[data-strata-scroll]');
        scroll.appendChild(svg);
        pane.classList.add('is-rendered');
        setupTooltip(pane, svg);

        // 現在の記事がペインの中央に来るようにスクロールしておく
        const current = layout.nodes.filter(function (node) {
            return node.slug === pane.dataset.currentSlug;
        })[0];
        if (current) {
            scroll.scrollTop = Math.max(0, current.y - scroll.clientHeight / 2);
        }
    }

    /** custom-strata.hbs の固定ページ用グラフを初期化する */
    function init() {
        const container = document.querySelector('[data-strata]');
        if (!container) {
            return;
        }
        loadGraph(container.dataset.strataGraphUrl).then(function (posts) {
            renderPage(container, posts);
        }).catch(function (error) {
            console.error('[Hyperstrata] 引用グラフを描画できません:', error);
        });
    }

    /** 取得した記事配列から固定ページ用の SVG を描画してコンテナに挿入する */
    function renderPage(container, posts) {
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
            maxDepthShade: 6,
            titleMaxLength: 32,
            label: container.dataset.strataLabel || ''
        });
        const figure = document.createElement('div');
        figure.className = 'gh-strata-graph';
        figure.appendChild(svg);
        container.appendChild(figure);
        container.classList.add('is-rendered');
    }

    window.HyperstrataGraph = {
        buildLayout: buildLayout,
        buildPaneLayout: buildPaneLayout,
        assignColumns: assignColumns,
        computeEmphasis: computeEmphasis,
        buildStrataBands: buildStrataBands,
        strataBoundaryPath: strataBoundaryPath,
        parseGraph: parseGraph
    };

    if (typeof document !== 'undefined') {
        // 本文の表示を優先するため、ブラウザが手隙になってから初期化する(未対応ブラウザは setTimeout で代替)
        const start = function () {
            const schedule = window.requestIdleCallback || function (callback) {
                setTimeout(callback, 0);
            };
            schedule(function () {
                init();
                initPane();
            });
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', start);
        } else {
            start();
        }
    }
})();
