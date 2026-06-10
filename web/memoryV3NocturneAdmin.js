function renderMemoryV3NocturnePanel() {
  return `
  <div class="card">
    <h3>Memory V3 Explorer / Review</h3>
    <div class="hint">URI 树、Boot、alias、trigger 和 candidate 审核；reject 只追加归档事件。</div>
    <div class="grid">
      <div class="field"><label>User ID</label><input id="m3_user_id" placeholder="例如 992507212" /></div>
      <div class="field"><label>Namespace</label><input id="m3_namespace" placeholder="default" /></div>
      <div class="field" style="grid-column:1 / -1"><label>URI</label><input id="m3_uri" placeholder="core://user/&lt;id&gt;/memory/&lt;memoryId&gt;" /></div>
    </div>
    <div class="actions">
      <button type="button" id="btn-m3-tree">加载 URI 树</button>
      <button type="button" id="btn-m3-read">读取 URI</button>
      <button type="button" id="btn-m3-boot">Boot</button>
      <button type="button" id="btn-m3-review">候选审核</button>
      <span id="m3-status" class="muted"></span>
    </div>
    <div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>URI / ID</th><th>Source</th><th>Type</th><th>Text</th><th>Action</th></tr></thead><tbody id="m3-body"></tbody></table></div>
    <div class="grid" style="margin-top:12px">
      <div class="field"><label>Alias URI</label><input id="m3_alias_uri" placeholder="core://user/me/favorite" /></div>
      <div class="field"><label>Target URI</label><input id="m3_alias_target" placeholder="core://user/.../memory/..." /></div>
      <div class="field"><label>Trigger URI</label><input id="m3_trigger_uri" placeholder="core://user/.../memory/..." /></div>
      <div class="field"><label>Keyword</label><input id="m3_trigger_keyword" placeholder="关键词" /></div>
    </div>
    <div class="actions">
      <button type="button" id="btn-m3-alias-add">保存 Alias</button>
      <button type="button" id="btn-m3-alias-list">Alias 列表</button>
      <button type="button" id="btn-m3-trigger-add">保存 Trigger</button>
      <button type="button" id="btn-m3-trigger-list">Trigger 列表</button>
      <button type="button" id="btn-pjdb-diag">结构库诊断</button>
      <button type="button" id="btn-pjdb-clean">结构库清洗</button>
    </div>
  </div>`;
}

function renderMemoryV3NocturneClientScript() {
  return `
    function m3Params() {
      const params = new URLSearchParams();
      const userId = document.getElementById('m3_user_id').value.trim();
      const namespace = document.getElementById('m3_namespace').value.trim();
      if (userId) params.set('user_id', userId);
      if (namespace) params.set('namespace', namespace);
      return params;
    }

    function m3Status(text, ok) {
      const el = document.getElementById('m3-status');
      el.textContent = text;
      el.style.color = ok === false ? '#d12b5b' : '#2f9d62';
    }

    function renderM3Rows(rows, kind) {
      const list = Array.isArray(rows) ? rows : [];
      const body = document.getElementById('m3-body');
      if (list.length === 0) {
        body.innerHTML = '<tr><td colspan="5" class="muted">暂无数据</td></tr>';
        return;
      }
      body.innerHTML = list.map(function (row) {
        const uri = row.uri || row.aliasUri || row.id || '';
        const action = kind === 'review'
          ? '<button type="button" class="btn-m3-accept" data-id="' + escapeCell(row.id || '') + '">accept</button><button type="button" class="btn-m3-reject" data-id="' + escapeCell(row.id || '') + '">reject</button>'
          : '<button type="button" class="btn-m3-pick" data-uri="' + escapeCell(uri) + '">pick</button>';
        return '<tr>'
          + '<td class="mono">' + escapeCell(uri) + '</td>'
          + '<td>' + escapeCell(row.source || row.keyword || '') + '</td>'
          + '<td>' + escapeCell(row.type || row.status || '') + '</td>'
          + '<td title="' + escapeCell(row.preview || row.text || row.disclosure || '') + '">' + escapeCell(String(row.preview || row.text || row.disclosure || '').slice(0, 120)) + '</td>'
          + '<td>' + action + '</td>'
          + '</tr>';
      }).join('');
    }

    async function loadM3Tree() {
      m3Status('Loading tree...', true);
      try {
        const params = m3Params();
        params.set('limit', '120');
        const res = await authedFetch('/api/memory-v3/uri-tree?' + params.toString());
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'load failed');
        renderM3Rows(data.items || [], 'tree');
        m3Status('Tree loaded: ' + Number(data.count || 0), true);
      } catch (e) {
        m3Status(e.message, false);
      }
    }

    async function readM3Uri() {
      const uri = document.getElementById('m3_uri').value.trim();
      if (!uri) return m3Status('URI required', false);
      m3Status('Reading URI...', true);
      try {
        const params = m3Params();
        params.set('uri', uri);
        const res = await authedFetch('/api/memory-v3/read?' + params.toString());
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || data.reason || 'read failed');
        renderM3Rows([{ uri: data.uri, source: data.source, type: data.id, text: data.text }], 'read');
        m3Status('Read OK', true);
      } catch (e) {
        m3Status(e.message, false);
      }
    }

    async function loadM3Boot() {
      m3Status('Building boot...', true);
      try {
        const params = m3Params();
        const res = await authedFetch('/api/memory-v3/boot?' + params.toString());
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || data.reason || 'boot failed');
        renderM3Rows([{ uri: data.uri || 'system://boot', source: 'boot', type: 'digest', text: data.text || '' }], 'boot');
        m3Status('Boot ready', true);
      } catch (e) {
        m3Status(e.message, false);
      }
    }

    async function loadM3Review() {
      m3Status('Loading review...', true);
      try {
        const params = m3Params();
        params.set('status', 'candidate');
        params.set('limit', '80');
        const res = await authedFetch('/api/memory-v3/review?' + params.toString());
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'review failed');
        renderM3Rows(data.changesets || [], 'review');
        m3Status('Review loaded: ' + Number(data.count || 0), true);
      } catch (e) {
        m3Status(e.message, false);
      }
    }

    async function saveM3Alias() {
      try {
        const res = await authedFetch('/api/memory-v3/aliases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            namespace: document.getElementById('m3_namespace').value.trim(),
            alias_uri: document.getElementById('m3_alias_uri').value.trim(),
            target_uri: document.getElementById('m3_alias_target').value.trim()
          })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'alias failed');
        m3Status('Alias saved', true);
      } catch (e) {
        m3Status(e.message, false);
      }
    }

    async function listM3Aliases() {
      try {
        const res = await authedFetch('/api/memory-v3/aliases?' + m3Params().toString());
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'alias list failed');
        renderM3Rows(data.aliases || [], 'alias');
        m3Status('Aliases loaded', true);
      } catch (e) {
        m3Status(e.message, false);
      }
    }

    async function saveM3Trigger() {
      try {
        const res = await authedFetch('/api/memory-v3/triggers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            namespace: document.getElementById('m3_namespace').value.trim(),
            uri: document.getElementById('m3_trigger_uri').value.trim(),
            keyword: document.getElementById('m3_trigger_keyword').value.trim()
          })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'trigger failed');
        m3Status('Trigger saved', true);
      } catch (e) {
        m3Status(e.message, false);
      }
    }

    async function listM3Triggers() {
      try {
        const res = await authedFetch('/api/memory-v3/triggers?' + m3Params().toString());
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'trigger list failed');
        renderM3Rows(data.triggers || [], 'trigger');
        m3Status('Triggers loaded', true);
      } catch (e) {
        m3Status(e.message, false);
      }
    }

    async function loadProfileJournalDbDiag() {
      m3Status('Loading structured memory...', true);
      try {
        const res = await authedFetch('/api/profile-journal-db/diagnostics?limit=12');
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || data.reason || 'diagnostics failed');
        renderM3Rows([
          {
            uri: data.dbFile || 'profile_journal_db',
            source: 'profile_journal_db',
            type: data.primaryRead ? 'primary_read' : 'fallback',
            text: JSON.stringify({
              profileStatus: data.profileStatus,
              journalStatus: data.journalStatus,
              rollups: data.rollups,
              recentCleanups: data.recentCleanups
            })
          }
        ], 'diag');
        m3Status('Structured memory OK', true);
      } catch (e) {
        m3Status(e.message, false);
      }
    }

    async function cleanProfileJournalDb() {
      m3Status('Cleaning structured memory...', true);
      try {
        const res = await authedFetch('/api/profile-journal-db/clean', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: document.getElementById('m3_user_id').value.trim() })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'clean failed');
        renderM3Rows([
          {
            uri: 'profile_journal_db_clean',
            source: 'profile_journal_db',
            type: 'cleanup',
            text: JSON.stringify({ profile: data.profile, journal: data.journal })
          }
        ], 'diag');
        m3Status('Structured memory cleaned', true);
      } catch (e) {
        m3Status(e.message, false);
      }
    }

    async function reviewM3(id, action) {
      if (!id) return;
      try {
        const res = await authedFetch('/api/memory-v3/review/' + action, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || data.reason || action + ' failed');
        m3Status(action + ' OK: ' + id, true);
        await loadM3Review();
      } catch (e) {
        m3Status(e.message, false);
      }
    }

    function initMemoryV3NocturnePanel() {
      document.getElementById('btn-m3-tree').addEventListener('click', loadM3Tree);
      document.getElementById('btn-m3-read').addEventListener('click', readM3Uri);
      document.getElementById('btn-m3-boot').addEventListener('click', loadM3Boot);
      document.getElementById('btn-m3-review').addEventListener('click', loadM3Review);
      document.getElementById('btn-m3-alias-add').addEventListener('click', saveM3Alias);
      document.getElementById('btn-m3-alias-list').addEventListener('click', listM3Aliases);
      document.getElementById('btn-m3-trigger-add').addEventListener('click', saveM3Trigger);
      document.getElementById('btn-m3-trigger-list').addEventListener('click', listM3Triggers);
      document.getElementById('btn-pjdb-diag').addEventListener('click', loadProfileJournalDbDiag);
      document.getElementById('btn-pjdb-clean').addEventListener('click', cleanProfileJournalDb);
      document.getElementById('m3-body').addEventListener('click', function (ev) {
        const target = ev.target;
        if (!target) return;
        if (target.classList.contains('btn-m3-pick')) {
          document.getElementById('m3_uri').value = target.getAttribute('data-uri') || '';
        }
        if (target.classList.contains('btn-m3-accept')) reviewM3(target.getAttribute('data-id'), 'accept');
        if (target.classList.contains('btn-m3-reject')) reviewM3(target.getAttribute('data-id'), 'reject');
      });
    }`;
}

module.exports = {
  renderMemoryV3NocturneClientScript,
  renderMemoryV3NocturnePanel
};
