#!/usr/bin/env python3
"""Verify real Plasma tray registration and window recovery in hosted CI."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.request


def main():
    assert os.environ.get('GITHUB_ACTIONS') == 'true'
    assert os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
    evidence = Path('tmp/linux-kde-acceptance').resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    if len(sys.argv) == 1:
        with tempfile.TemporaryDirectory(prefix='aiolm-kde-', dir=os.environ['RUNNER_TEMP']) as directory:
            env = {k: v for k, v in os.environ.items() if not k.startswith(('AIOLM_', 'LLAMA_BOARD_'))
                   and k not in ('DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS')}
            for key, sub in {'HOME': 'home', 'USERPROFILE': 'home', 'APPDATA': 'roaming', 'LOCALAPPDATA': 'local',
                             'XDG_CONFIG_HOME': 'config', 'XDG_DATA_HOME': 'data', 'XDG_CACHE_HOME': 'cache',
                             'XDG_RUNTIME_DIR': 'run', 'AIOLM_HOME': 'aiolm'}.items():
                path = Path(directory, sub)
                path.mkdir(mode=0o700, exist_ok=True)
                env[key] = str(path)
            env.update(GDK_BACKEND='x11', XDG_CURRENT_DESKTOP='KDE', KDE_SESSION_VERSION='5', KDE_FULL_SESSION='true',
                       TAURI_WEBVIEW_AUTOMATION='true', WEBKIT_DISABLE_DMABUF_RENDERER='1',
                       QT_X11_NO_MITSHM='1', LIBGL_ALWAYS_SOFTWARE='1')
            subprocess.run(['xvfb-run', '-a', '-s', '-screen 0 1280x900x24', 'dbus-run-session', '--',
                            sys.executable, __file__, 'child'], env=env, check=True, timeout=180)
        return
    from gi.repository import Gio, GLib
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)

    def dbus(dest, path, interface, method, args=None):
        return bus.call_sync(dest, path, interface, method, args, None, Gio.DBusCallFlags.NONE, 3000, None).unpack()

    processes = []
    session = None
    try:
        for command in [['kwin_x11', '--replace'], ['plasmashell', '--no-respawn'], ['WebKitWebDriver', '--port=4444']]:
            processes.append(subprocess.Popen(command))
        dbus('org.kde.kded5', '/kded', 'org.kde.kded5', 'loadModule',
             GLib.Variant('(s)', ('statusnotifierwatcher',)))
        last_error = 'host not registered'
        for _ in range(150):
            try:
                available = dbus('org.kde.StatusNotifierWatcher', '/StatusNotifierWatcher',
                                 'org.freedesktop.DBus.Properties', 'Get',
                                 GLib.Variant('(ss)', ('org.kde.StatusNotifierWatcher', 'IsStatusNotifierHostRegistered')))[0]
                if available:
                    break
            except GLib.Error as error:
                last_error = str(error)
            time.sleep(.2)
        else:
            raise RuntimeError('Plasma has no registered tray host: ' + last_error)
        debs = list(Path('.codex-target/release/bundle/deb').glob('*.deb'))
        assert len(debs) == 1
        unpacked = Path(os.environ['HOME'], 'package')
        subprocess.run(['dpkg-deb', '-x', str(debs[0]), str(unpacked)], check=True)

        def request(method, path, body=None):
            req = urllib.request.Request('http://127.0.0.1:4444' + path,
                                         data=None if body is None else json.dumps(body).encode(),
                                         headers={'Content-Type': 'application/json'}, method=method)
            with urllib.request.urlopen(req, timeout=45) as response:
                return json.load(response)['value']

        session = request('POST', '/session', {'capabilities': {'alwaysMatch': {
            'webkitgtk:browserOptions': {'binary': str(unpacked / 'usr/bin/aiolm'), 'args': []}
        }}})['sessionId']

        def execute(script, *args):
            return request('POST', f'/session/{session}/execute/sync', {'script': script, 'args': args})

        def invoke(command, args=None):
            execute('window.__probe=null;window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]).then(value=>window.__probe={value},error=>window.__probe={error:String(error)})', command, args or {})
            for _ in range(100):
                result = execute('return window.__probe')
                if result is not None:
                    assert 'error' not in result, result
                    return result.get('value')
                time.sleep(.1)
            raise TimeoutError(command)

        config = invoke('get_config')
        config['close_to_tray'] = True
        invoke('save_config', {'cfg': config})
        time.sleep(1)
        items = dbus('org.kde.StatusNotifierWatcher', '/StatusNotifierWatcher',
                     'org.freedesktop.DBus.Properties', 'Get',
                     GLib.Variant('(ss)', ('org.kde.StatusNotifierWatcher', 'RegisteredStatusNotifierItems')))[0]
        menu = None
        for item in items:
            dest, _, suffix = item.partition('/')
            dest = dest.rstrip('@')
            path = '/' + suffix if suffix else '/StatusNotifierItem'
            props = dbus(dest, path, 'org.freedesktop.DBus.Properties', 'GetAll', GLib.Variant('(s)', ('org.kde.StatusNotifierItem',)))[0]
            if 'aiolm' in str(props.get('Id', '')).lower():
                menu = props['Menu']
                break
        assert menu, 'Plasma did not register AioLM'
        layout = dbus(dest, menu, 'com.canonical.dbusmenu', 'GetLayout', GLib.Variant('(iias)', (0, -1, [])))
        labels = {node[1]['label']: node[0] for node in layout[1][2] if 'label' in node[1]}
        invoke('plugin:window|close', {'label': 'main'})
        assert invoke('plugin:window|is_visible', {'label': 'main'}) is False
        dbus(dest, menu, 'com.canonical.dbusmenu', 'Event',
             GLib.Variant('(isvu)', (labels['Show AioLM'], 'clicked', GLib.Variant('i', 0), 0)))
        time.sleep(.2)
        assert invoke('plugin:window|is_visible', {'label': 'main'}) is True
        import base64
        (evidence / 'plasma-app.png').write_bytes(base64.b64decode(request('GET', f'/session/{session}/screenshot')))
        dbus(dest, menu, 'com.canonical.dbusmenu', 'Event',
             GLib.Variant('(isvu)', (labels['Quit AioLM'], 'clicked', GLib.Variant('i', 0), 0)))
        for _ in range(100):
            if not dbus('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                        'NameHasOwner', GLib.Variant('(s)', (dest,)))[0]:
                break
            time.sleep(.1)
        else:
            raise AssertionError('tray Quit did not terminate the app')
        (evidence / 'result.json').write_text(json.dumps({'desktop': 'KDE Plasma X11', 'registered': True,
                                                        'closeHides': True, 'showRestores': True, 'quitExited': True}, indent=2))
        print('Actual Plasma host registration, hide and Show/Quit menu passed.')
    finally:
        if session:
            try:
                request('DELETE', f'/session/{session}')
            except (OSError, KeyError):
                pass
        for process in reversed(processes):
            process.terminate()
        for process in reversed(processes):
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


if __name__ == '__main__':
    main()
