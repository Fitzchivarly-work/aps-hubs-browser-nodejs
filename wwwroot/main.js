import { initViewer, loadModel } from './viewer.js';
import { initTree } from './sidebar.js';

const login = document.getElementById('login');
const sidebarToggle = document.getElementById('sidebar-toggle');
const body = document.body;

function isTabletLayout() {
    return window.matchMedia('(max-width: 1024px)').matches;
}

function syncSidebarState() {
    if (isTabletLayout()) {
        body.classList.add('tablet-layout');
        if (!body.classList.contains('sidebar-open')) {
            body.classList.add('sidebar-collapsed');
        }
    } else {
        body.classList.remove('tablet-layout');
        body.classList.remove('sidebar-collapsed');
        body.classList.add('sidebar-open');
    }

    if (sidebarToggle) {
        const expanded = !body.classList.contains('sidebar-collapsed');
        sidebarToggle.setAttribute('aria-expanded', String(expanded));
    }
}

if (sidebarToggle) {
    sidebarToggle.addEventListener('click', () => {
        body.classList.toggle('sidebar-collapsed');
        body.classList.toggle('sidebar-open', !body.classList.contains('sidebar-collapsed'));
        syncSidebarState();
    });
}

window.addEventListener('resize', syncSidebarState);
syncSidebarState();

try {
    const resp = await fetch('/api/auth/profile');
    if (resp.ok) {
        const user = await resp.json();
        login.innerText = `Logout (${user.name})`;
        login.onclick = () => {
            const iframe = document.createElement('iframe');
            iframe.style.visibility = 'hidden';
            iframe.src = 'https://accounts.autodesk.com/Authentication/LogOut';
            document.body.appendChild(iframe);
            iframe.onload = () => {
                window.location.replace('/api/auth/logout');
                document.body.removeChild(iframe);
            };
        }
        const viewer = await initViewer(document.getElementById('preview'));
        initTree('#tree', (id) => {
            if (isTabletLayout()) {
                body.classList.add('sidebar-collapsed');
                body.classList.remove('sidebar-open');
                syncSidebarState();
            }
            loadModel(viewer, Autodesk.Viewing.toUrlSafeBase64(id));
        });
    } else {
        login.innerText = 'Login';
        login.onclick = () => window.location.replace('/api/auth/login');
    }
    login.style.visibility = 'visible';
} catch (err) {
    alert('Could not initialize the application. See console for more details.');
    console.error(err);
}
