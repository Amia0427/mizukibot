function renderMainReplyContextPreviewPanel() {
  return `
  <div class="card">
    <h3>主回复上下文预览</h3>
    <div class="hint">只读摘要：短期连续性、Memory V3/本地记忆、日记和 MemOS 召回是否进入主回复。</div>
    <div class="actions"><button type="button" id="btn-context-preview-load">刷新上下文预览</button><span id="context-preview-updated" class="muted"></span></div>
    <div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>时间</th><th>User</th><th>Profile</th><th>Raw</th><th>Summary</th><th>Memory V3</th><th>Journal</th><th>MemOS</th><th>Trim</th></tr></thead><tbody id="context-preview-body"></tbody></table></div>
  </div>`;
}

function renderMainReplyContextPreviewClientScript() {
  return `
    function renderContextPreview(preview) {
      const body = document.getElementById('context-preview-body');
      const rows = Array.isArray(preview && preview.observations) ? preview.observations : [];
      document.getElementById('context-preview-updated').textContent = preview && preview.updatedAt ? ('updated: ' + preview.updatedAt) : '';
      if (rows.length === 0) {
        body.innerHTML = '<tr><td colspan="9" class="muted">暂无上下文观测</td></tr>';
        return;
      }
      body.innerHTML = rows.slice().reverse().map(function (row) {
        const st = row.shortTermContinuity || {};
        const raw = String(Number(st.selectedRawTurnCount || 0)) + '/' + String(Number(st.rawTurnCount || 0));
        const trim = Array.isArray(st.trimReasons) ? st.trimReasons.join(', ') : '';
        return '<tr>'
          + '<td>' + escapeCell(row.ts || '') + '</td>'
          + '<td class="mono">' + escapeCell(row.userId || '-') + '</td>'
          + '<td>' + escapeCell(st.contextProfile || '-') + '</td>'
          + '<td>' + escapeCell(raw) + '</td>'
          + '<td>' + Number(st.sessionSummaryCount || 0) + '</td>'
          + '<td>' + (row.hasRetrievedMemoryLite || row.localMemoryEvidenceCount > 0 ? 'yes' : 'no') + '</td>'
          + '<td>' + (row.hasDailyJournal ? 'yes' : 'no') + '</td>'
          + '<td>' + (row.hasMemosRecall || row.memosUsed ? 'yes' : 'no') + '</td>'
          + '<td title="' + escapeCell(trim) + '">' + escapeCell(trim || '-') + '</td>'
          + '</tr>';
      }).join('');
    }

    async function loadContextPreview() {
      try {
        const res = await authedFetch('/api/main-reply-context-preview?limit=12');
        const data = await res.json();
        if (!res.ok || !data.ok) return;
        renderContextPreview(data.preview || {});
      } catch (_) {}
    }

    function initMainReplyContextPreview() {
      document.getElementById('btn-context-preview-load').addEventListener('click', loadContextPreview);
      loadContextPreview();
      setInterval(loadContextPreview, 5000);
    }`;
}

module.exports = {
  renderMainReplyContextPreviewClientScript,
  renderMainReplyContextPreviewPanel
};
