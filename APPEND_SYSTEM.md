Whenever user asks to create a markdown document, add the document to ~/work/ai-notes/<current_dir_name>/ where `current_dir_name` will be the current directory name. Create the folder if missing.
Commit the document and push it.

You can also refer to documents contained in ai-notes/<current_dir_name> folder

---

* Be extremely concise. Sacrifice grammar for the sake of concision.
* DO NOT RUN FULL TESTS SUITE
* Always use `rg` i.e. ripgrep instead of in-build grep for searching text.
* Always use `fd` instead of `find` to search for files.
* Except for ~/work/ai-notes/ folder, do not search anything outside of current folder/repository unless specifically instructed.
