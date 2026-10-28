Private files for the resume service. Everything here except this README is gitignored.
Copy them from E:\Projects\Resume Optimizer with `python sync_assets.py` (one folder up), keeping this layout:

    assets/
      bases/Base_MLEngineer.tex, Base_CVResearch.tex, Base_BackendSystems.tex
      tools/verify.py, ats_check.py, fact_check.py, build_check.py
      master_resume.md      fallback only; the app sends the latest synced masters with every request
      vault_master.md       fallback only, copy of vault\AboutMe\Master Resume MD.md

Redeploy after you change a base or a gate script. Master edits need no redeploy.
