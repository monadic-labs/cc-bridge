const state = {
    config: null,
    daemonConfig: null,
    schema: null,
    extensions: null,
    activeTab: 'providers',
    daemonConfigDraft: null,
    daemonConfigError: ''
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
        const [configRes, schemaRes, daemonRes, extensionsRes] = await Promise.all([
            fetch('/api/config'),
            fetch('/api/schema'),
            fetch('/api/daemon-config'),
            fetch('/api/extensions')
        ]);
        state.config = await configRes.json();
        state.schema = await schemaRes.json();
        state.daemonConfig = await daemonRes.json();
        state.extensions = await extensionsRes.json();
        state.daemonConfigDraft = JSON.stringify(state.daemonConfig, null, 2);
        state.daemonConfigError = '';
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
    setTimeout(() => { toast.style.display = 'none'; }, 4000);
}

function render() {
    content.innerHTML = '';
    const tab = state.activeTab;

    if (tab === 'providers') return renderProviders();
    if (tab === 'routes') return renderRoutes();
    if (tab === 'extensions') return renderExtensions();
    if (tab === 'daemon') return renderDaemonConfig();
    if (tab === 'status') return renderStatus();
}

// ── Providers ───────────────────────────────────────────────────────────

function renderProviders() {
    const providers = state.config.providers || {};
    let html = '<h2>Upstream Providers</h2>';

    Object.entries(providers).forEach(([id, cfg]) => {
        const compliant = cfg.anthropicCompliant === true ? 'checked' : '';
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
                <div class="form-group">
                    <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
                        <input type="checkbox" ${compliant} onchange="updateConfig('providers.${id}.anthropicCompliant', this.checked)" style="width: auto;">
                        <span>Anthropic-compliant (preserve cache_control, betas, system array, thinking signatures)</span>
                    </label>
                    <small style="color: #64748b; font-size: 0.8rem;">Enable for endpoints that speak Anthropic protocol natively (anthropic.com, z.ai /api/anthropic, mirrors). Disable for OpenAI-shape and unknown backends.</small>
                </div>
                ${renderModelsTable(id, cfg.models || {})}
                ${renderToolTransforms(id, cfg.toolTransforms || {})}
                <button class="secondary" onclick="deleteProvider('${escapeAttr(id)}')">Remove Provider</button>
            </div>
        `;
    });

    html += '<button onclick="addProvider()">+ Add Provider</button>';
    content.innerHTML = html;
}

function renderModelsTable(providerId, models) {
    const rows = Object.entries(models).map(([alias, real]) => `
        <div class="list-item">
            <div style="flex: 1; display: flex; gap: 0.5rem; align-items: center;">
                <input type="text" value="${escapeAttr(alias)}" disabled style="flex: 1;">
                <span>→</span>
                <input type="text" value="${escapeAttr(real)}" onchange="updateConfig('providers.${providerId}.models.${alias}', this.value)" style="flex: 1;">
            </div>
            <button class="secondary" onclick="deleteModel('${escapeAttr(providerId)}', '${escapeAttr(alias)}')">Remove</button>
        </div>
    `).join('');

    return `
        <div class="form-group">
            <label>Models (alias → real model name)</label>
            <div class="card" style="background: rgba(15, 23, 42, 0.5); padding: 0.75rem; margin: 0;">
                ${rows || '<p style="color: #64748b; font-size: 0.85rem;">No model aliases.</p>'}
                <div style="display: flex; gap: 0.5rem; margin-top: 0.75rem;">
                    <input type="text" placeholder="alias (e.g. fast)" id="new-model-alias-${providerId}" style="flex: 1;">
                    <input type="text" placeholder="real model (e.g. glm-4.7)" id="new-model-real-${providerId}" style="flex: 1;">
                    <button onclick="addModel('${escapeAttr(providerId)}')">+ Add</button>
                </div>
            </div>
        </div>
    `;
}

function renderToolTransforms(providerId, toolTransforms) {
    const json = JSON.stringify(toolTransforms || {}, null, 2);
    return `
        <div class="form-group">
            <label>Tool Transforms (JSON)</label>
            <textarea rows="4" onchange="updateToolTransforms('${escapeAttr(providerId)}', this.value)">${escapeHtml(json)}</textarea>
            <small style="color: #64748b; font-size: 0.8rem;">Per-tool overrides forwarded to extensions. Example: <code>{ "web_search": { "search_engine": "search-prime" } }</code></small>
        </div>
    `;
}

function addModel(providerId) {
    const alias = $(`new-model-alias-${providerId}`).value.trim();
    const real = $(`new-model-real-${providerId}`).value.trim();
    if (!alias || !real) {
        showToast('Both alias and real model are required', 'error');
        return;
    }
    if (!state.config.providers[providerId].models) state.config.providers[providerId].models = {};
    state.config.providers[providerId].models[alias] = real;
    render();
}

function deleteModel(providerId, alias) {
    delete state.config.providers[providerId].models[alias];
    render();
}

function updateToolTransforms(providerId, jsonStr) {
    try {
        const parsed = JSON.parse(jsonStr);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            showToast('Tool transforms must be a JSON object', 'error');
            return;
        }
        state.config.providers[providerId].toolTransforms = parsed;
    } catch (e) {
        showToast(`Invalid JSON for ${providerId} toolTransforms: ${e.message}`, 'error');
    }
}

// ── Routes ──────────────────────────────────────────────────────────────

function renderRoutes() {
    const routes = state.config.routes || {};
    const models = routes.models || {};
    const properties = routes.properties || {};
    const payloadSize = routes.payloadSize || {};
    const defaults = routes.defaults || {};

    let html = '<h2>Routing Rules</h2>';

    html += `<div class="card"><h3>Model aliases</h3>${renderRouteMap('models', models)}</div>`;
    html += `<div class="card"><h3>Property-based rules</h3>${renderRouteMap('properties', properties)}<small style="color: #64748b; font-size: 0.8rem;">Match by request body property (e.g. <code>thinking</code> → <code>z.glm-5.1</code>).</small></div>`;
    html += `<div class="card"><h3>Payload-size rules</h3>${renderRouteMap('payloadSize', payloadSize)}<small style="color: #64748b; font-size: 0.8rem;">Match by request size (e.g. <code>&gt;102400</code> → <code>my-mirror.claude-opus-4-6</code>).</small></div>`;

    const fallbackArr = Array.isArray(defaults.fallback) ? defaults.fallback : [];
    html += `
        <div class="card">
            <h3>Default fallback</h3>
            <div class="form-group">
                <label>Fallback target (provider.model). Used when no rule matches.</label>
                <input type="text" value="${escapeAttr(fallbackArr[0] || '')}" onchange="updateConfig('routes.defaults.fallback', this.value ? [this.value] : [])">
            </div>
        </div>
    `;

    content.innerHTML = html;
}

function renderRouteMap(section, map) {
    const rows = Object.entries(map).map(([key, value]) => {
        const display = typeof value === 'string' ? value : JSON.stringify(value);
        return `
            <div class="list-item">
                <div>
                    <strong>${escapeHtml(key)}</strong>
                    <span class="tag">➔ ${escapeHtml(display)}</span>
                </div>
                <button class="secondary" onclick="deleteRouteEntry('${escapeAttr(section)}', '${escapeAttr(key)}')">Remove</button>
            </div>
        `;
    }).join('');

    return `
        ${rows || '<p style="color: #64748b; font-size: 0.85rem; margin: 0.5rem 0;">No entries.</p>'}
        <div style="display: flex; gap: 0.5rem; margin-top: 0.75rem;">
            <input type="text" placeholder="key (e.g. *sonnet*, thinking, &gt;102400)" id="new-${section}-key" style="flex: 1;">
            <input type="text" placeholder="target (provider.model or JSON)" id="new-${section}-val" style="flex: 1;">
            <button onclick="addRouteEntry('${escapeAttr(section)}')">+ Add</button>
        </div>
    `;
}

function addRouteEntry(section) {
    const key = $(`new-${section}-key`).value.trim();
    const rawVal = $(`new-${section}-val`).value.trim();
    if (!key || !rawVal) {
        showToast('Both key and target are required', 'error');
        return;
    }
    let value = rawVal;
    if (rawVal.startsWith('{')) {
        try { value = JSON.parse(rawVal); }
        catch (e) {
            showToast(`Invalid JSON for target: ${e.message}`, 'error');
            return;
        }
    }
    if (!state.config.routes) state.config.routes = {};
    if (!state.config.routes[section]) state.config.routes[section] = {};
    state.config.routes[section][key] = value;
    render();
}

function deleteRouteEntry(section, key) {
    if (!state.config.routes?.[section]?.[key]) return;
    if (!confirm(`Remove ${section}.${key}?`)) return;
    delete state.config.routes[section][key];
    render();
}

// Legacy aliases preserved for back-compat with any external references
function addRoute() { return addRouteEntry('models'); }
function deleteRoute(alias) { return deleteRouteEntry('models', alias); }

// ── Extensions ──────────────────────────────────────────────────────────

function renderExtensions() {
    const extensionConfigs = state.config.extensions || {};
    const installed = Array.isArray(state.extensions) ? state.extensions : [];
    let html = '<h2>Extensions</h2>';
    html += '<p style="color: #94a3b8; font-size: 0.9rem;">Every extension currently loaded by the daemon. Some are user-tunable (schema form below); others activate automatically based on provider or route configuration.</p>';

    if (installed.length === 0) {
        html += '<p style="color: #94a3b8;">No extensions registered.</p>';
        content.innerHTML = html;
        return;
    }

    installed.forEach((ext) => {
        const cfg = extensionConfigs[ext.name] || {};
        const activationLabel = ({
            'always': 'Always on',
            'route-driven': 'Activates per-route',
            'provider-driven': 'Activates per-provider',
        })[ext.activation] || ext.activation;

        const configuredByLine = ext.configuredBy
            ? `<p style="color: #64748b; font-size: 0.75rem;">Configured by: <code>${escapeHtml(ext.configuredBy)}</code></p>`
            : '';

        const formOrPlaceholder = ext.schema
            ? renderSchemaForm(`extensions.${ext.name}`, ext.schema, cfg)
            : '<p style="color: #64748b; font-size: 0.85rem; font-style: italic;">No user-tunable settings — this extension activates automatically based on the configuration above.</p>';

        html += `
            <div class="card" data-extension="${escapeAttr(ext.name)}">
                <div style="display: flex; justify-content: space-between; align-items: baseline; gap: 1rem;">
                    <h3 style="margin: 0;">${escapeHtml(ext.title || ext.name)}</h3>
                    <span class="tag" style="white-space: nowrap;">${escapeHtml(activationLabel)}</span>
                </div>
                <p style="color: #94a3b8; font-size: 0.9rem;">${escapeHtml(ext.description || '')}</p>
                ${configuredByLine}
                ${formOrPlaceholder}
            </div>
        `;
    });

    content.innerHTML = html;
}

function renderSchemaForm(p, schema, value) {
    if (schema.type !== 'object') return '';

    if (schema.properties) {
        return Object.entries(schema.properties).map(([key, prop]) => renderProperty(`${p}.${key}`, key, prop, value?.[key])).join('');
    }

    if (schema.additionalProperties) {
        return renderAdditionalProperties(p, schema.additionalProperties, value || {});
    }

    return '';
}

function renderProperty(path, key, prop, value) {
    const label = escapeHtml(prop.title || key);
    const help = prop.description ? `<small style="color: #64748b; font-size: 0.8rem;">${escapeHtml(prop.description)}</small>` : '';

    if (prop.type === 'object' && (prop.properties || prop.additionalProperties)) {
        return `
            <div class="form-group">
                <label>${label}</label>
                ${help}
                <div style="border-left: 2px solid var(--border); padding-left: 1rem; margin-top: 0.5rem;">
                    ${renderSchemaForm(path, prop, value)}
                </div>
            </div>
        `;
    }

    return `
        <div class="form-group">
            <label>${label}</label>
            ${renderInput(path, prop, value)}
            ${help}
        </div>
    `;
}

function renderAdditionalProperties(p, valueSchema, current) {
    const rows = Object.entries(current).map(([key, entry]) => `
        <div class="card" style="background: rgba(15, 23, 42, 0.4); margin: 0.5rem 0; padding: 0.75rem;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                <strong>${escapeHtml(key)}</strong>
                <button class="secondary" onclick="deleteMapEntry('${escapeAttr(p)}', '${escapeAttr(key)}')">Remove</button>
            </div>
            ${renderSchemaForm(`${p}.${key}`, valueSchema, entry)}
        </div>
    `).join('');

    const inputId = `new-map-key-${p.replace(/\./g, '-')}`;
    return `
        ${rows || '<p style="color: #64748b; font-size: 0.85rem; margin: 0.5rem 0;">No entries.</p>'}
        <div style="display: flex; gap: 0.5rem; margin-top: 0.5rem;">
            <input type="text" placeholder="new key" id="${inputId}" style="flex: 1;">
            <button onclick="addMapEntry('${escapeAttr(p)}', '${escapeAttr(inputId)}')">+ Add</button>
        </div>
    `;
}

function addMapEntry(p, inputId) {
    const key = $(inputId).value.trim();
    if (!key) {
        showToast('Key is required', 'error');
        return;
    }
    const parts = p.split('.');
    let current = state.config;
    for (const part of parts) {
        if (!current[part]) current[part] = {};
        current = current[part];
    }
    if (current[key]) {
        showToast(`Entry "${key}" already exists`, 'error');
        return;
    }
    current[key] = {};
    render();
}

function deleteMapEntry(p, key) {
    const parts = p.split('.');
    let current = state.config;
    for (const part of parts) {
        if (!current[part]) return;
        current = current[part];
    }
    delete current[key];
    render();
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
    if (prop.type === 'boolean') {
        return `<input type="checkbox" ${value === true ? 'checked' : ''} onchange="updateConfig('${p}', this.checked)" style="width: auto;">`;
    }
    if (prop.type === 'array') {
        const lines = Array.isArray(value) ? value.join('\n') : '';
        return `<textarea onchange="updateConfig('${p}', this.value.split('\\n').filter(Boolean))">${escapeHtml(lines)}</textarea>`;
    }
    return `<input type="text" value="${escapeAttr(value)}" onchange="updateConfig('${p}', this.value)">`;
}

// ── Daemon Config ───────────────────────────────────────────────────────

function renderDaemonConfig() {
    const draft = state.daemonConfigDraft ?? JSON.stringify(state.daemonConfig ?? {}, null, 2);
    content.innerHTML = `
        <h2>Daemon Config</h2>
        <p style="color: #94a3b8;">Settings stored in <code>~/.claude/.ccb/config.json</code>. Validated before write; the daemon hot-reloads on save.</p>
        <div class="card">
            <div class="form-group">
                <label>config.json</label>
                <textarea id="daemon-config-editor" rows="24" style="font-family: ui-monospace, 'SF Mono', Consolas, monospace; font-size: 0.85rem;">${escapeHtml(draft)}</textarea>
                <p id="daemon-config-error" style="color: var(--error); font-size: 0.85rem; margin: 0.5rem 0; display: none;"></p>
            </div>
            <p style="color: #64748b; font-size: 0.8rem;">Key fields: <code>port</code>, <code>daemon.healthCheckTimeoutMs</code>, <code>daemon.upstreamTimeoutMs</code>, <code>daemon.workerKeepaliveS</code>, <code>daemon.ipcTimeoutMs</code>, <code>logging.level</code>, <code>compression.recompressRequests</code>.</p>
        </div>
    `;
    const editor = $('daemon-config-editor');
    const errorEl = $('daemon-config-error');
    // If the previous render had an error pending (tab switch with pending
    // error), surface it immediately.
    if (state.daemonConfigError) {
        errorEl.textContent = state.daemonConfigError;
        errorEl.style.display = 'block';
    }
    editor.addEventListener('input', () => {
        state.daemonConfigDraft = editor.value;
        try {
            JSON.parse(editor.value);
            state.daemonConfigError = '';
            errorEl.textContent = '';
            errorEl.style.display = 'none';
        } catch (e) {
            state.daemonConfigError = `JSON parse error: ${e.message}`;
            errorEl.textContent = state.daemonConfigError;
            errorEl.style.display = 'block';
        }
    });
}

// ── Status ──────────────────────────────────────────────────────────────

async function renderStatus() {
    content.innerHTML = '<h2>Daemon Status</h2><p style="color: #94a3b8;">Loading...</p>';
    try {
        const [statusRes, sessionRes, logsRes] = await Promise.all([
            fetch('/__ccb_internal__/status'),
            fetch('/__ccb_internal__/session'),
            fetch('/api/logs?lines=80')
        ]);
        if (!statusRes.ok) {
            content.innerHTML = `<h2>Daemon Status</h2><p style="color: var(--error);">Status endpoint returned ${statusRes.status}.</p>`;
            return;
        }
        const status = await statusRes.json();
        const session = sessionRes.ok ? await sessionRes.json() : null;
        const logs = logsRes.ok ? await logsRes.text() : '';
        const uptime = formatDuration(status.uptime_sec);

        const historyRows = (session?.history ?? []).map(line => `<code style="display: block; font-size: 0.8rem; color: #94a3b8;">${escapeHtml(line)}</code>`).join('') || '<p style="color: #64748b; font-size: 0.85rem;">No requests recorded yet.</p>';

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
                <div style="display: flex; gap: 0.5rem; margin-top: 1rem;">
                    <button onclick="restartDaemon()">Restart Daemon</button>
                    <button class="secondary" onclick="renderStatus()">Refresh</button>
                </div>
            </div>
            ${session ? `
                <div class="card">
                    <h3>Session totals</h3>
                    <div class="list-item"><div>Total requests</div><div class="tag">${escapeHtml(session.total_requests)}</div></div>
                    <div class="list-item"><div>Total input tokens</div><div class="tag">${escapeHtml(session.total_input_tokens)}</div></div>
                    <div class="list-item"><div>Total output tokens</div><div class="tag">${escapeHtml(session.total_output_tokens)}</div></div>
                    <div class="list-item"><div>Last Claude session ID</div><div class="tag">${escapeHtml(session.claude_session_id || '(none)')}</div></div>
                </div>
                <div class="card">
                    <h3>Recent requests</h3>
                    ${historyRows}
                </div>
            ` : ''}
            <div class="card">
                <h3>Log tail</h3>
                <pre style="background: #0f172a; padding: 1rem; border-radius: 0.4rem; max-height: 300px; overflow: auto; font-size: 0.8rem; color: #cbd5e1; margin: 0;">${escapeHtml(logs) || '<em>(empty)</em>'}</pre>
            </div>
        `;
    } catch (e) {
        content.innerHTML = `<h2>Daemon Status</h2><p style="color: var(--error);">Failed to load status: ${escapeHtml(e.message)}</p>`;
    }
}

async function restartDaemon() {
    if (!confirm('Restart the proxy daemon? In-flight requests will drain on the old worker.')) return;
    try {
        const res = await fetch('/api/restart', { method: 'POST' });
        if (!res.ok) {
            showToast('Restart failed: ' + await res.text(), 'error');
            return;
        }
        showToast('Restart requested. Reloading status in 2s...');
        setTimeout(() => renderStatus(), 2000);
    } catch (e) {
        showToast('Restart error: ' + e.message, 'error');
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

// ── Provider/route shared helpers ──────────────────────────────────────

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

// ── Save ────────────────────────────────────────────────────────────────

async function save() {
    let savedAny = false;
    try {
        const res = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(state.config)
        });
        if (!res.ok) {
            showToast('Failed to save providers: ' + await res.text(), 'error');
            return;
        }
        savedAny = true;
    } catch (e) {
        showToast('Save error (providers): ' + e.message, 'error');
        return;
    }

    if (state.daemonConfigDraft && state.daemonConfigDraft !== JSON.stringify(state.daemonConfig, null, 2)) {
        try {
            const parsed = JSON.parse(state.daemonConfigDraft);
            const res = await fetch('/api/daemon-config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(parsed)
            });
            if (!res.ok) {
                showToast('Daemon config rejected: ' + await res.text(), 'error');
                return;
            }
            savedAny = true;
        } catch (e) {
            showToast(`Daemon config error: ${e.message}`, 'error');
            return;
        }
    }

    if (savedAny) showToast('Configuration saved and hot-reloaded');
    await load();
}

// Expose for inline onclick handlers
window.addProvider = addProvider;
window.deleteProvider = deleteProvider;
window.addModel = addModel;
window.deleteModel = deleteModel;
window.updateToolTransforms = updateToolTransforms;
window.addRoute = addRoute;
window.deleteRoute = deleteRoute;
window.addRouteEntry = addRouteEntry;
window.deleteRouteEntry = deleteRouteEntry;
window.updateConfig = updateConfig;
window.addMapEntry = addMapEntry;
window.deleteMapEntry = deleteMapEntry;
window.restartDaemon = restartDaemon;
window.renderStatus = renderStatus;

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
