/**
 * Agent Session Bridge — Client half.
 *
 * Frame:
 *   1. choose a direction (Codex → DSH, or DSH → Codex)
 *   2. browse the SOURCE the way that agent groups itself: projects → conversations
 *   3. inspect one conversation, then import it into the target
 *
 * Data comes from the Host's /agent-bridge/{state,preview,migrate} endpoints.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-bridge',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const DICT = {
      zh: {
        panel: '会话互通',
        title: '会话互通',
        subtitle: '在 DeepSeek Harness 与 Codex 之间搬运对话。导入只新增，绝不改写已有内容。',
        pickDirection: '选择迁移方向',
        c2d: 'Codex → DeepSeek Harness',
        c2dNote: '把 Codex 里的对话搬到 DSH。写入 DSH 会话库，只新建文件。',
        d2c: 'DeepSeek Harness → Codex',
        d2cNote: '把 DSH 里的对话搬回 Codex。写入 rollout 并登记索引，会先自动备份 Codex 索引库。',
        back: '重新选择方向',
        projects: '项目',
        conversations: '个对话',
        ungrouped: '未分组',
        refresh: '刷新',
        pickProject: '左侧选择一个项目',
        pickSession: '选择一个对话查看详情',
        loading: '读取中…',
        rounds: '轮次',
        msgs: '消息',
        tools: '工具调用',
        target: '导入到',
        targetHint: '目标工作目录（决定它出现在对方的哪个项目里）',
        doImport: '开始导入',
        importing: '导入中…',
        done: '已导入',
        failed: '失败',
        duplicate: '已迁移过',
        backup: '索引库备份',
        empty: '没有可迁移的对话。',
        preview: '会话预览',
        noCwd: '（无工作目录）',
        source: '来源',
        size: '大小',
      },
      en: {
        panel: 'Session Bridge',
        title: 'Session Bridge',
        subtitle: 'Move conversations between DeepSeek Harness and Codex. Imports only add; nothing existing is rewritten.',
        pickDirection: 'Choose a direction',
        c2d: 'Codex → DeepSeek Harness',
        c2dNote: 'Bring Codex conversations into DSH. Writes new files only.',
        d2c: 'DeepSeek Harness → Codex',
        d2cNote: 'Bring DSH conversations back to Codex. Writes a rollout and indexes it, backing the Codex index up first.',
        back: 'Choose another direction',
        projects: 'Projects',
        conversations: 'conversations',
        ungrouped: 'Ungrouped',
        refresh: 'Refresh',
        pickProject: 'Select a project on the left',
        pickSession: 'Select a conversation to inspect it',
        loading: 'Loading…',
        rounds: 'Turns',
        msgs: 'Messages',
        tools: 'Tool calls',
        target: 'Import into',
        targetHint: 'Target working directory — decides which project it lands in',
        doImport: 'Import',
        importing: 'Importing…',
        done: 'Imported',
        failed: 'Failed',
        duplicate: 'Already migrated',
        backup: 'Index backup',
        empty: 'No conversations to migrate.',
        preview: 'Preview',
        noCwd: '(no working directory)',
        source: 'Source',
        size: 'Size',
      },
    };
    const lang =
      (typeof document !== 'undefined' && document.documentElement?.lang ? document.documentElement.lang : 'zh')
        .toLowerCase()
        .startsWith('zh')
        ? 'zh'
        : 'en';
    const t = (key) => DICT[lang][key] ?? DICT.en[key] ?? key;

    const T = {
      text: 'var(--dsw-alias-label-primary, inherit)',
      dim: 'var(--dsw-alias-label-secondary, rgba(140,140,140,1))',
      border: 'var(--dsw-alias-border-l1, rgba(128,128,128,.25))',
      borderStrong: 'var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
      layer: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06))',
      layer2: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.1))',
      brand: 'var(--dsw-alias-brand-primary, #3b82f6)',
      warn: 'var(--dsw-alias-state-warn-primary, #d97706)',
      ok: 'var(--dsw-alias-state-success-primary, #16a34a)',
      err: 'var(--dsw-alias-state-error-primary, #dc2626)',
    };

    const DIRECTION = {
      codex2dsh: { source: 'codex', target: 'dsh', key: 'c2d', note: 'c2dNote' },
      dsh2codex: { source: 'dsh', target: 'codex', key: 'd2c', note: 'd2cNote' },
    };

    function bytes(n) {
      if (!n) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB'];
      let i = 0;
      let v = n;
      while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i += 1;
      }
      return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
    }

    function when(ms) {
      if (!ms) return '';
      const diff = Date.now() - ms;
      if (diff < 3600e3) return `${Math.max(1, Math.round(diff / 60e3))}m`;
      if (diff < 86400e3) return `${Math.round(diff / 3600e3)}h`;
      if (diff < 604800e3) return `${Math.round(diff / 86400e3)}d`;
      return new Date(ms).toLocaleDateString();
    }

    function shortPath(p) {
      if (!p) return '';
      const home = p.replace(/^\/Users\/[^/]+/, '~');
      return home.length > 46 ? `…${home.slice(-45)}` : home;
    }

    /** Panels are dense; every interactive element is outlined so it reads on any theme. */
    const buttonStyle = (primary) => ({
      padding: '7px 16px',
      borderRadius: 9,
      border: `1px solid ${primary ? T.brand : T.border}`,
      background: 'transparent',
      color: primary ? T.brand : T.text,
      fontSize: 13,
      fontWeight: 500,
      fontFamily: 'inherit',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    });

    function Chip({ children, color }) {
      return h(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '1px 8px',
            borderRadius: 999,
            border: `1px solid ${T.border}`,
            fontSize: 11,
            lineHeight: '18px',
            color: color || T.dim,
            whiteSpace: 'nowrap',
          },
        },
        children,
      );
    }

    function Icon(props) {
      const size = props.size || 18;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', { d: 'M4 7h9M4 12h6M4 17h9' }),
        h('path', { d: 'M17 6v12' }),
        h('path', { d: 'M14 9l3-3 3 3' }),
        h('path', { d: 'M20 15l-3 3-3-3' }),
      );
    }

    function Panel() {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState('');
      const [direction, setDirection] = React.useState(null);
      const [expanded, setExpanded] = React.useState({});
      const [selected, setSelected] = React.useState(null);
      const [detail, setDetail] = React.useState(null);
      const [detailBusy, setDetailBusy] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState(null);
      const [target, setTarget] = React.useState('');

      const load = React.useCallback(async () => {
        try {
          const response = await fetch('/agent-bridge/state', { headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          setData(await response.json());
          setError('');
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        }
      }, []);

      React.useEffect(() => {
        load();
      }, [load]);

      const openSession = async (adapter, row) => {
        setSelected({ adapter, id: row.id, row });
        setDetail(null);
        setDetailBusy(true);
        setTarget(row.cwd || '');
        setNotice(null);
        try {
          const response = await fetch('/agent-bridge/preview', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ adapter, sessionId: row.id }),
          });
          setDetail(await response.json());
        } catch (cause) {
          setDetail({ error: String(cause?.message ?? cause) });
        } finally {
          setDetailBusy(false);
        }
      };

      const runImport = async () => {
        if (!selected || !direction) return;
        const map = DIRECTION[direction];
        setBusy(true);
        setNotice(null);
        try {
          const response = await fetch('/agent-bridge/migrate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              adapter: map.source,
              sessionId: selected.id,
              to: map.target,
              cwd: target || selected.row.cwd,
            }),
          });
          const result = await response.json();
          if (result.ok) {
            setNotice({ kind: 'ok', text: `${t('done')} · ${result.to.file ?? result.to.id}` , backup: result.to.backup });
            await load();
          } else {
            setNotice({
              kind: 'warn',
              text: `${result.duplicate ? t('duplicate') : t('failed')}${result.reason ? ` · ${result.reason}` : ''}`,
            });
          }
        } catch (cause) {
          setNotice({ kind: 'err', text: `${t('failed')} · ${String(cause?.message ?? cause)}` });
        } finally {
          setBusy(false);
        }
      };

      /* ---------------------------------------------------------- direction */

      const directionCards = h(
        'div',
        { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 18 } },
        Object.keys(DIRECTION).map((key) =>
          h(
            'button',
            {
              key,
              type: 'button',
              onClick: () => {
                setDirection(key);
                setSelected(null);
                setDetail(null);
                setNotice(null);
                setExpanded({});
              },
              style: {
                textAlign: 'left',
                padding: '16px 18px',
                borderRadius: 12,
                border: `1px solid ${T.borderStrong}`,
                background: T.layer,
                color: T.text,
                fontFamily: 'inherit',
                cursor: 'pointer',
              },
            },
            h('div', { style: { fontSize: 14, fontWeight: 600 } }, t(DIRECTION[key].key)),
            h('div', { style: { marginTop: 6, fontSize: 12, color: T.dim, lineHeight: 1.55 } }, t(DIRECTION[key].note)),
          ),
        ),
      );

      /* --------------------------------------------------------------- tree */

      let body = null;
      if (direction && data) {
        const map = DIRECTION[direction];
        const groups = data.groups?.[map.source] ?? [];
        const sourceMeta = (data.adapters ?? []).find((adapter) => adapter.id === map.source);
        const total = groups.reduce((sum, group) => sum + group.sessions.length, 0);

        const tree = h(
          'div',
          { style: { width: 320, flex: '0 0 320px', borderRight: `1px solid ${T.border}`, overflow: 'auto', padding: '4px 0' } },
          groups.length === 0
            ? h('div', { style: { padding: '20px 14px', fontSize: 12.5, color: T.dim } }, t('empty'))
            : groups.map((group) => {
                const open = expanded[group.id] === true;
                return h(
                  'div',
                  { key: group.id },
                  h(
                    'button',
                    {
                      type: 'button',
                      onClick: () => setExpanded((prev) => ({ ...prev, [group.id]: !open })),
                      style: {
                        width: '100%',
                        textAlign: 'left',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 7,
                        padding: '8px 12px',
                        border: 'none',
                        background: open ? T.layer2 : 'transparent',
                        color: T.text,
                        fontFamily: 'inherit',
                        cursor: 'pointer',
                      },
                    },
                    h('span', { style: { width: 10, color: T.dim, fontSize: 10 } }, open ? '▾' : '▸'),
                    h(
                      'span',
                      { style: { flex: '1 1 auto', minWidth: 0, fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                      group.label,
                    ),
                    h('span', { style: { flex: '0 0 auto', fontSize: 11, color: T.dim } }, String(group.sessions.length)),
                  ),
                  open
                    ? group.sessions.map((row) =>
                        h(
                          'button',
                          {
                            key: row.id,
                            type: 'button',
                            onClick: () => openSession(map.source, row),
                            style: {
                              width: '100%',
                              textAlign: 'left',
                              display: 'block',
                              padding: '7px 12px 7px 30px',
                              border: 'none',
                              borderLeft: `2px solid ${selected?.id === row.id ? T.brand : 'transparent'}`,
                              background: selected?.id === row.id ? T.layer2 : 'transparent',
                              color: T.text,
                              fontFamily: 'inherit',
                              cursor: 'pointer',
                            },
                          },
                          h(
                            'div',
                            { style: { fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                            row.title || row.id,
                          ),
                          h('div', { style: { marginTop: 1, fontSize: 10.5, color: T.dim } }, `${bytes(row.bytes)} · ${when(row.updatedAt)}`),
                        ),
                      )
                    : null,
                );
              }),
        );

        const statLine = detail && !detail.error
          ? h(
              'div',
              { style: { display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' } },
              h(Chip, null, `${t('rounds')} ${detail.turns}`),
              h(Chip, null, `${t('msgs')} ${detail.messages}`),
              h(Chip, null, `${t('tools')} ${detail.toolCalls}`),
              h(Chip, null, `${t('size')} ${bytes(detail.bytes)}`),
            )
          : null;

        const opening = detail?.opening?.length
          ? h(
              'div',
              { style: { marginTop: 16 } },
              h('div', { style: { fontSize: 12, color: T.dim, marginBottom: 6 } }, t('preview')),
              detail.opening.map((item, index) =>
                h(
                  'div',
                  {
                    key: index,
                    style: {
                      padding: '9px 12px',
                      marginBottom: 6,
                      borderRadius: 9,
                      background: T.layer,
                      border: `1px solid ${T.border}`,
                      fontSize: 12,
                      lineHeight: 1.6,
                      color: T.text,
                    },
                  },
                  h('div', { style: { fontSize: 10.5, color: T.dim, marginBottom: 3 } }, item.role === 'user' ? t('source') : 'DSH/Codex'),
                  item.text,
                ),
              ),
            )
          : null;

        const detailPane = h(
          'div',
          { style: { flex: '1 1 auto', minWidth: 0, overflow: 'auto', padding: '16px 20px' } },
          !selected
            ? h('div', { style: { fontSize: 12.5, color: T.dim, paddingTop: 24 } }, t('pickSession'))
            : h(
                'div',
                null,
                h('div', { style: { fontSize: 15, fontWeight: 600, lineHeight: 1.4 } }, detail?.title || selected.row.title || selected.id),
                h('div', { style: { marginTop: 4, fontSize: 11.5, color: T.dim } }, shortPath(detail?.cwd || selected.row.cwd)),
                detailBusy ? h('div', { style: { marginTop: 14, fontSize: 12, color: T.dim } }, t('loading')) : statLine,
                opening,
                h(
                  'div',
                  { style: { marginTop: 20 } },
                  h('div', { style: { fontSize: 12, color: T.dim, marginBottom: 5 } }, t('target')),
                  h('input', {
                    value: target,
                    onChange: (event) => setTarget(event.target.value),
                    style: {
                      width: '100%',
                      boxSizing: 'border-box',
                      padding: '8px 11px',
                      borderRadius: 9,
                      border: `1px solid ${T.border}`,
                      background: 'transparent',
                      color: T.text,
                      fontSize: 12.5,
                      fontFamily: 'inherit',
                      outline: 'none',
                    },
                  }),
                  h('div', { style: { marginTop: 5, fontSize: 11, color: T.dim } }, t('targetHint')),
                ),
                h(
                  'div',
                  { style: { marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 } },
                  h(
                    'button',
                    { type: 'button', disabled: busy, onClick: runImport, style: { ...buttonStyle(true), opacity: busy ? 0.6 : 1 } },
                    busy ? t('importing') : t('doImport'),
                  ),
                  notice
                    ? h(
                        'div',
                        { style: { fontSize: 11.5, color: notice.kind === 'ok' ? T.ok : notice.kind === 'warn' ? T.warn : T.err, wordBreak: 'break-all' } },
                        notice.text,
                        notice.backup ? h('div', { style: { color: T.dim, marginTop: 3 } }, `${t('backup')}: ${shortPath(notice.backup)}`) : null,
                      )
                    : null,
                ),
              ),
        );

        body = h(
          'div',
          null,
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, marginBottom: 8 } },
            h('button', { type: 'button', onClick: () => setDirection(null), style: buttonStyle(false) }, `← ${t('back')}`),
            h('div', { style: { fontSize: 12.5, color: T.dim } }, `${t(DIRECTION[direction].key)} · ${total} ${t('conversations')}`),
            h('div', { style: { flex: '1 1 auto' } }),
            h('button', { type: 'button', onClick: load, style: buttonStyle(false) }, t('refresh')),
          ),
          h(
            'div',
            {
              style: {
                display: 'flex',
                minHeight: 420,
                height: 'calc(100vh - 300px)',
                border: `1px solid ${T.border}`,
                borderRadius: 12,
                overflow: 'hidden',
                background: T.layer,
              },
            },
            tree,
            detailPane,
          ),
        );
      } else if (direction) {
        body = h('div', { style: { marginTop: 20, fontSize: 12.5, color: T.dim } }, t('loading'));
      }

      const driftNotice =
        data?.schema && data.schema.status !== 'match' && data.schema.status !== 'unavailable'
          ? h('div', { style: { marginTop: 12, fontSize: 12, color: T.warn } }, `⚠ ${data.schema.detail}`)
          : null;

      return h(
        'div',
        {
          style: {
            height: '100%',
            overflow: 'auto',
            padding: '24px 28px 40px',
            boxSizing: 'border-box',
            background: 'var(--dsw-alias-bg-base, transparent)',
          },
        },
        h(
          'div',
          { style: { maxWidth: 1040, margin: '0 auto' } },
          h(
            'div',
            null,
            h('div', { style: { fontSize: 17, fontWeight: 600 } }, t('title')),
            h('div', { style: { marginTop: 4, fontSize: 12.5, color: T.dim, lineHeight: 1.55, maxWidth: 760 } }, t('subtitle')),
          ),
          driftNotice,
          direction ? null : h('div', { style: { marginTop: 4, fontSize: 12.5, color: T.dim } }, t('pickDirection')),
          direction ? null : directionCards,
          body,
          error ? h('div', { style: { marginTop: 10, fontSize: 12, color: T.err } }, error) : null,
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: 'agent-session-bridge', order: 30, label: () => t('panel') }, Icon),
        );
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'agent-session-bridge' }, Panel),
        );
      },
    };
  },
});
