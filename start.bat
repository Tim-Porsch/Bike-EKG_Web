@echo off
setlocal
cd /d "%~dp0"
py -3 -c "import sys; assert sys.version_info >= (3, 9)" >nul 2>&1
if errorlevel 1 goto try_python
py -3 "%~dp0start.py" %*
goto finished

:try_python
python -c "import sys; assert sys.version_info >= (3, 9)" >nul 2>&1
if errorlevel 1 goto missing_python
python "%~dp0start.py" %*
goto finished

:missing_python
echo Python 3.9 oder neuer wurde nicht gefunden.
echo Bitte Python installieren und diesen Starter erneut oeffnen.
pause
exit /b 1

:finished
if not errorlevel 1 exit /b 0
echo Der Starter wurde mit einem Fehler beendet.
pause
exit /b 1
