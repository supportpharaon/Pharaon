"""Windows startup management via Registry."""

import sys
import os

APP_NAME = "Pharaon"
REG_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"


def get_exe_path():
    if getattr(sys, 'frozen', False):
        return sys.executable
    script = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'main.py'))
    python = sys.executable
    return f'"{python}" "{script}"'


def set_autostart(enabled: bool) -> bool:
    try:
        import winreg
        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER, REG_KEY,
            0, winreg.KEY_SET_VALUE
        )
        if enabled:
            winreg.SetValueEx(key, APP_NAME, 0, winreg.REG_SZ, get_exe_path())
        else:
            try:
                winreg.DeleteValue(key, APP_NAME)
            except FileNotFoundError:
                pass
        winreg.CloseKey(key)
        return True
    except Exception:
        return False


def is_autostart_enabled() -> bool:
    try:
        import winreg
        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER, REG_KEY,
            0, winreg.KEY_READ
        )
        winreg.QueryValueEx(key, APP_NAME)
        winreg.CloseKey(key)
        return True
    except (FileNotFoundError, OSError):
        return False
