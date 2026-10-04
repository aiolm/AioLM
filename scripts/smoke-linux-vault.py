#!/usr/bin/env python3
"""Run real Secret Service lock/cancel/recovery checks in disposable sessions."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid


def child(binary, graphical):
    root = Path(os.environ["AIOLM_VAULT_SESSION_ROOT"]).resolve()
    assert root.name.startswith("aiolm-vault-")
    for key in ("HOME", "AIOLM_HOME", "XDG_RUNTIME_DIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME"):
        assert Path(os.environ[key]).resolve().parent == root, "refuse a non-isolated vault session"
    import gi
    from gi.repository import Gio, GLib

    password = b'synthetic-vault-test-password'

    def unlock():
        subprocess.run(['gnome-keyring-daemon', '--replace', '--unlock', '--components=secrets',
                        '--control-directory=' + os.environ['XDG_RUNTIME_DIR'] + '/keyring'],
                       input=password, check=True, stdout=subprocess.DEVNULL, timeout=10)

    unlock()
    args = [binary, '--ignored', '--exact',
            'benchmark::sharing::vault::tests::real_locked_vault_preserves_secret',
            '--test-threads=1', '--nocapture']
    env = dict(os.environ, AIOLM_VAULT_USER='synthetic-smoke-' + str(uuid.uuid4()))

    def run(phase):
        current = dict(env, AIOLM_VAULT_PHASE=phase)
        if phase != 'locked' or not graphical:
            subprocess.run(args, env=current, check=True, timeout=30)
            return
        gi.require_version('Atspi', '2.0')
        from gi.repository import Atspi

        def cancel(node):
            if node.get_name() == 'Cancel' and node.get_role_name() in ('button', 'push button'):
                return node.get_action_iface().do_action(0)
            return any(cancel(node.get_child_at_index(i)) for i in range(node.get_child_count()))

        process = subprocess.Popen(args, env=current)
        try:
            count = 0
            deadline = time.monotonic() + 30
            while process.poll() is None and time.monotonic() < deadline:
                desktop = Atspi.get_desktop(0)
                for i in range(desktop.get_child_count()):
                    app = desktop.get_child_at_index(i)
                    if app.get_name() == 'gcr-prompter' and cancel(app):
                        count += 1
                        time.sleep(.3)
                time.sleep(.1)
            assert process.poll() == 0, 'locked vault command did not finish successfully'
            assert count == 2, f'expected read and write authentication prompts, got {count}'
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=5)

    run('seed')
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)

    def call(method, args):
        return bus.call_sync('org.freedesktop.secrets', '/org/freedesktop/secrets',
                             'org.freedesktop.Secret.Service', method, args, None,
                             Gio.DBusCallFlags.NONE, 3000, None).unpack()

    collection = call('ReadAlias', GLib.Variant('(s)', ('default',)))[0]
    assert collection != '/'
    assert collection in call('Lock', GLib.Variant('(ao)', ([collection],)))[0]
    try:
        run('locked')
    finally:
        unlock()
    run('recover')
    print('Secret Service lock, ' + ('native authentication cancellation, ' if graphical else 'headless refusal, ')
          + 'restart/unlock and original-secret preservation passed.')


def main():
    assert sys.platform == 'linux'
    if len(sys.argv) == 4 and sys.argv[1] == 'child':
        child(sys.argv[2], sys.argv[3] == 'graphical')
        return
    # Resolve the test executable before changing HOME/CARGO_HOME for isolation.
    built = subprocess.run(['cargo', 'test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml',
                            '--lib', '--all-features', '--no-run', '--message-format=json'],
                           capture_output=True, text=True, check=True, timeout=600)
    executables = []
    for line in built.stdout.splitlines():
        artifact = json.loads(line)
        if artifact.get('reason') == 'compiler-artifact' and artifact.get('executable'):
            if artifact['target']['name'] == 'aiolm_lib':
                executables.append(str(Path(artifact['executable']).resolve()))
    assert len(executables) == 1, 'expected one native library test executable'
    for graphical in (False, True):
        with tempfile.TemporaryDirectory(prefix='aiolm-vault-') as directory:
            env = {k: v for k, v in os.environ.items() if not k.startswith(('AIOLM_', 'LLAMA_BOARD_'))
                   and k not in ('DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS',
                                 'GNOME_KEYRING_CONTROL', 'SSH_AUTH_SOCK', 'NO_AT_BRIDGE')}
            for key, sub in {'HOME': 'home', 'USERPROFILE': 'home', 'APPDATA': 'roaming', 'LOCALAPPDATA': 'local',
                             'XDG_DATA_HOME': 'data', 'XDG_CONFIG_HOME': 'config',
                             'XDG_CACHE_HOME': 'cache', 'XDG_RUNTIME_DIR': 'run', 'AIOLM_HOME': 'aiolm'}.items():
                path = Path(directory, sub)
                path.mkdir(mode=0o700, exist_ok=True)
                env[key] = str(path)
            env.update(GDK_BACKEND='x11', LANG='C.UTF-8', LC_ALL='C.UTF-8', AIOLM_VAULT_SESSION_ROOT=directory)
            args = ['dbus-run-session', '--', sys.executable, str(Path(__file__).resolve()), 'child',
                    executables[0], 'graphical' if graphical else 'headless']
            if graphical:
                args = ['xvfb-run', '-a', *args]
            subprocess.run(args, env=env, check=True, timeout=100)


if __name__ == '__main__':
    main()
