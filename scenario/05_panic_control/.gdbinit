# Auto-generated .gdbinit for F-BB Scenario
set pagination off
set print pretty on
python
import os, sys
scenario_dir = os.path.dirname(os.path.abspath(gdb.current_progspace().filename)) if (hasattr(gdb, 'current_progspace') and gdb.current_progspace() and gdb.current_progspace().filename) else "."
gdb_script = os.path.join(scenario_dir, "fbb_gdb.py")
if os.path.exists(gdb_script):
    gdb.execute(f"source {gdb_script}")
end
