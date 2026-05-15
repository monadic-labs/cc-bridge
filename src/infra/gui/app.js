const state = {
    config: null,
    schema: null,
    activeTab: 'providers'
};

const $ = (id) => document.getElementById(id);
const content = $('content');

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
    return escapeHtml(value);
}

async function load() {
    try {
        const [configRes, schemaRes] = await Promise.all([
            fetch('/api/config'),
            fetch('/api/schema')
        ]);
        state.config = await configRes.json();
        state.schema = await schemaRes.json();
        render();
    } catch (e) {
        showToast('Failed to load configuration: ' + e.message, 'error');
    }
}

function showToast(msg, type) {
    const toast = $('toast');
    toast.textContent = msg;
    toast.style.display = 'block';
    toast.style.background = type === 'error' ? 'var(--error)' : 'var(--success)';
    setTimeout(() => { toast.style.display = 'none'; }, 3000);
}

function render() {
    content.innerHTML = '';
    const tab = state.activeTab;

    if (tab === 'providers') return renderProviders();
    if (tab === 'routes') return renderRoutes();
    if (tab === 'extensions') return renderExtensions();
    if (tab === 'status') return renderStatus();
}

function renderProviders() {
    const providers = state.config.providers || {};
    let html = '<h2>Upstream Providers</h2>';

    Object.entries(providers).forEach(([id, cfg]) => {
        html += `
            <div class="card">
                <div class="form-group">
                    <label>ID</label>
                    <input type="text" value="${escapeAttr(id)}" disabled>
                </div>
                <div class="form-group">
                    <label>URL</label>
                    <input type="text" value="${escapeAttr(cfg.url)}" onchange="updateConfig('providers.${id}.url', this.value)">
                </div>
                <div class="form-group">
                    <label>API Key (use ENV:VAR_NAME to read from .env)</label>
                    <input type="text" value="${escapeAttr(cfg.apiKey)}" onchange="updateConfig('providers.${id}.apiKey', this.value)">
                </div>
                <button class="secondary" onclick="deleteProvider('${escapeAttr(id)}')">Remove Provider</button>
            </div>
        `;
    });

    html += '<button onclick="addProvider()">+ Add Provider</button>';
    content.innerHTML = html;
}

function renderRoutes() {
    const models = state.config.routes?.models || {};
    let html = '<h2>Model Routing</h2>';

    html += '<div class="card">';
    if (Object.keys(models).length === 0) {
        html += '<p style="color: #94a3b8;">No routes configured.</p>';
    }
    Object.entries(models).forEach(([alias, target]) => {
        const targetStr = typeof target === 'string'
            ? target
            : (target.target || target.pool || JSON.stringify(target));
        html += `
            <div class="list-item">
                <div>
                    <strong>${escapeHtml(alias)}</strong>
                    <span class="tag">➔ ${escapeHtml(targetStr)}</span>
                </div>
                <button class="secondary" onclick="deleteRoute('${escapeAttr(alias)}')">Remove</button>
            </div>
        `;
    });
    html += '</div>';

    html += `
        <div class="card">
            <h3>Add Route</h3>
            <div class="form-group">
                <label>Model Name / Wildcard (e.g. *sonnet*)</label>
                <input type="text" id="new-route-key" placeholder="*sonnet*">
            </div>
            <div class="form-group">
                <label>Target (provider.model or poolName)</label>
                <input type="text" id="new-route-val" placeholder="z.glm-4.7">
            </div>
            <button onclick="addRoute()">Add Route</button>
        </div>
    `;
    content.innerHTML = html;
}

function renderExtensions() {
    const extensions = state.config.extensions || {};
    const schemas = state.schema?.extensions || {};
    let html = '<h2>Extension Settings</h2>';

    if (Object.keys(schemas).length === 0) {
        html += '<p style="color: #94a3b8;">No extensions registered.</p>';
        content.innerHTML = html;
        return;
    }

    Object.entries(schemas).forEach(([id, schema]) => {
        const cfg = extensions[id] || {};
        html += `
            <div class="card">
                <h3>${escapeHtml(schema.title || id)}</h3>
                <p style="color: #94a3b8; font-size: 0.9rem;">${escapeHtml(schema.description || '')}</p>
                ${renderSchemaForm(`extensions.${id}`, schema, cfg)}
            </div>
        `;
    });

    content.innerHTML = html;
}

function renderSchemaForm(p, schema, value) {
    if (schema.type !== 'object' || !schema.properties) return '';
    return Object.entries(schema.properties).map(([key, prop]) => {
        return `
            <div class="form-group">
                <label>${escapeHtml(prop.title || key)}</label>
                ${renderInput(`${p}.${key}`, prop, value?.[key])}
                ${prop.description ? `<small style="color: #64748b; font-size: 0.8rem;">${escapeHtml(prop.description)}</small>` : ''}
            </div>
        `;
    }).join('');
}

function renderInput(p, prop, value) {
    if (prop.enum) {
        const current = value ?? prop.default;
        return `
            <select onchange="updateConfig('${p}', this.value)">
                ${prop.enum.map(v => `<option value="${escapeAttr(v)}" ${v === current ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('')}
            </select>
        `;
    }
    if (prop.type === 'array') {
        const lines = Array.isArray(value) ? value.join('\n') : '';
        return `<textarea onchange="updateConfig('${p}', this.value.split('\\n').filter(Boolean))">${escapeHtml(lines)}</textarea>`;
    }
    return `<input type="text" value="${escapeAttr(value)}" onchange="updateConfig('${p}', this.value)">`;
}

async function renderStatus() {
    content.innerHTML = '<h2>Daemon Status</h2><p style="color: #94a3b8;">Loading...</p>';
    try {
        const res = await fetch('/__ccb_internal__/status');
        if (!res.ok) {
            content.innerHTML = `<h2>Daemon Status</h2><p style="color: var(--error);">Status endpoint returned ${res.status}.</p>`;
            return;
        }
        const status = await res.json();
        const uptime = formatDuration(status.uptime_sec);
        content.innerHTML = `
            <h2>Daemon Status</h2>
            <div class="card">
                <div class="list-item"><div>Version</div><div class="tag">${escapeHtml(status.version)}</div></div>
                <div class="list-item"><div>Worker PID</div><div class="tag">${escapeHtml(status.worker_pid)}</div></div>
                <div class="list-item"><div>Uptime</div><div class="tag">${escapeHtml(uptime)}</div></div>
                <div class="list-item"><div>Active connections</div><div class="tag">${escapeHtml(status.active_connections)}</div></div>
                <div class="list-item"><div>Keepalives</div><div class="tag">${escapeHtml(status.keepalives)}</div></div>
                <div class="list-item"><div>Logs</div><div class="tag">${escapeHtml(status.log_path)}</div></div>
                <div class="list-item"><div>Config</div><div class="tag">${escapeHtml(status.config_path)}</div></div>
            </div>
        `;
    } catch (e) {
        content.innerHTML = `<h2>Daemon Status</h2><p style="color: var(--error);">Failed to load status: ${escapeHtml(e.message)}</p>`;
    }
}

function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) return '?';
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h${m}m${sec}s`;
    if (m > 0) return `${m}m${sec}s`;
    return `${sec}s`;
}

function updateConfig(p, value) {
    const parts = p.split('.');
    let current = state.config;
    for (let i = 0; i < parts.length - 1; i++) {
        if (!current[parts[i]]) current[parts[i]] = {};
        current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
}

function addProvider() {
    const id = prompt('Provider ID (alphanumeric, dashes, underscores):');
    if (!id) return;
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
        showToast('Invalid provider ID', 'error');
        return;
    }
    if (!state.config.providers) state.config.providers = {};
    if (state.config.providers[id]) {
        showToast(`Provider "${id}" already exists`, 'error');
        return;
    }
    state.config.providers[id] = {
        url: '',
        apiKey: `ENV:${id.toUpperCase()}_KEY`,
        models: {},
        anthropicCompliant: false,
        toolTransforms: {}
    };
    render();
    showToast(`Added provider "${id}". Set URL and click Save.`);
}

function deleteProvider(id) {
    if (!state.config.providers || !state.config.providers[id]) return;
    if (!confirm(`Remove provider "${id}"?`)) return;
    delete state.config.providers[id];
    render();
}

function addRoute() {
    const key = $('new-route-key').value.trim();
    const val = $('new-route-val').value.trim();
    if (!key || !val) {
        showToast('Both model name and target are required', 'error');
        return;
    }
    if (!state.config.routes) state.config.routes = {};
    if (!state.config.routes.models) state.config.routes.models = {};
    state.config.routes.models[key] = val;
    render();
}

function deleteRoute(alias) {
    if (!state.config.routes?.models?.[alias]) return;
    if (!confirm(`Remove route "${alias}"?`)) return;
    delete state.config.routes.models[alias];
    render();
}

async function save() {
    try {
        const res = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(state.config)
        });
        if (!res.ok) {
            showToast('Failed to save: ' + await res.text(), 'error');
            return;
        }
        showToast('Configuration saved and hot-reloaded');
        await load();
    } catch (e) {
        showToast('Save error: ' + e.message, 'error');
    }
}

window.addProvider = addProvider;
window.deleteProvider = deleteProvider;
window.addRoute = addRoute;
window.deleteRoute = deleteRoute;
window.updateConfig = updateConfig;

document.querySelectorAll('#menu li').forEach(li => {
    li.onclick = () => {
        const current = document.querySelector('#menu li.active');
        if (current) current.classList.remove('active');
        li.classList.add('active');
        state.activeTab = li.dataset.tab;
        render();
    };
});

$('save-btn').onclick = save;

load();
