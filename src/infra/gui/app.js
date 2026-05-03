let state = {
    config: null,
    schema: null,
    activeTab: 'providers'
};

const $ = (id) => document.getElementById(id);
const content = $('content');

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

function showToast(msg, type = 'success') {
    const toast = $('toast');
    toast.textContent = msg;
    toast.style.display = 'block';
    toast.style.background = type === 'success' ? 'var(--success)' : 'var(--error)';
    setTimeout(() => { toast.style.display = 'none'; }, 3000);
}

function render() {
    content.innerHTML = '';
    const tab = state.activeTab;

    if (tab === 'providers') renderProviders();
    else if (tab === 'routes') renderRoutes();
    else if (tab === 'extensions') renderExtensions();
    else if (tab === 'status') renderStatus();
}

function renderProviders() {
    const providers = state.config.providers || {};
    let html = '<h2>Upstream Providers</h2>';
    
    Object.entries(providers).forEach(([id, cfg]) => {
        html += `
            <div class="card">
                <div class="form-group">
                    <label>ID</label>
                    <input type="text" value="${id}" disabled>
                </div>
                <div class="form-group">
                    <label>URL</label>
                    <input type="text" value="${cfg.url || ''}" onchange="updateConfig('providers.${id}.url', this.value)">
                </div>
                <div class="form-group">
                    <label>API Key (Environment Variable)</label>
                    <input type="text" value="${cfg.apiKey || ''}" onchange="updateConfig('providers.${id}.apiKey', this.value)">
                </div>
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
    Object.entries(models).forEach(([alias, target]) => {
        const targetStr = typeof target === 'string' ? target : (target.target || target.pool || '');
        html += `
            <div class="list-item">
                <div>
                    <strong>${alias}</strong>
                    <span class="tag">➔ ${targetStr}</span>
                </div>
                <button class="secondary" onclick="deleteRoute('${alias}')">Remove</button>
            </div>
        `;
    });
    html += '</div>';
    
    html += `
        <div class="card">
            <h3>Add Route</h3>
            <div class="form-group">
                <label>Model Name / Wildcard (e.g. *sonnet*)</label>
                <input type="text" id="new-route-key">
            </div>
            <div class="form-group">
                <label>Target (provider.model or poolName)</label>
                <input type="text" id="new-route-val">
            </div>
            <button onclick="addRoute()">Add Route</button>
        </div>
    `;
    content.innerHTML = html;
}

function renderExtensions() {
    const extensions = state.config.extensions || {};
    const schemas = state.schema.extensions || {};
    let html = '<h2>Extension Settings</h2>';

    Object.entries(schemas).forEach(([id, schema]) => {
        const config = extensions[id] || {};
        html += `
            <div class="card">
                <h3>${schema.title || id}</h3>
                <p style="color: #94a3b8; font-size: 0.9rem;">${schema.description || ''}</p>
                ${renderSchemaForm(`extensions.${id}`, schema, config)}
            </div>
        `;
    });

    content.innerHTML = html;
}

function renderSchemaForm(path, schema, value) {
    if (schema.type === 'object' && schema.properties) {
        return Object.entries(schema.properties).map(([key, prop]) => {
            return `
                <div class="form-group">
                    <label>${prop.title || key}</label>
                    ${renderInput(`${path}.${key}`, prop, value[key])}
                    ${prop.description ? `<small style="color: #64748b; font-size: 0.8rem;">${prop.description}</small>` : ''}
                </div>
            `;
        }).join('');
    }
    return '';
}

function renderInput(path, prop, value) {
    if (prop.enum) {
        return `
            <select onchange="updateConfig('${path}', this.value)">
                ${prop.enum.map(v => `<option value="${v}" ${v === (value || prop.default) ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
        `;
    }
    if (prop.type === 'array') {
        return `<textarea onchange="updateConfig('${path}', this.value.split('\\n').filter(Boolean))">${(value || []).join('\n')}</textarea>`;
    }
    return `<input type="text" value="${value || ''}" onchange="updateConfig('${path}', this.value)">`;
}

function updateConfig(path, value) {
    const parts = path.split('.');
    let current = state.config;
    for (let i = 0; i < parts.length - 1; i++) {
        if (!current[parts[i]]) current[parts[i]] = {};
        current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
}

async function save() {
    try {
        const res = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(state.config)
        });
        if (res.ok) {
            showToast('Configuration saved and hot-reloaded');
        } else {
            showToast('Failed to save: ' + await res.text(), 'error');
        }
    } catch (e) {
        showToast('Save error: ' + e.message, 'error');
    }
}

// Menu interaction
document.querySelectorAll('#menu li').forEach(li => {
    li.onclick = () => {
        document.querySelector('#menu li.active').classList.remove('active');
        li.classList.add('active');
        state.activeTab = li.dataset.tab;
        render();
    };
});

$('save-btn').onclick = save;

load();
