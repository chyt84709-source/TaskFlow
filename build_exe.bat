@echo off
setlocal
call .venv\Scripts\activate.bat
python -m PyInstaller --noconfirm --clean --onefile --windowed --name FrameSpeakStudio main.py
echo.
echo EXE created at dist\FrameSpeakStudio.exe
pause
