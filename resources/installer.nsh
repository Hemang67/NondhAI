; Installer welcome page showing the app's tagline.
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to Nondh AI"
  !define MUI_WELCOMEPAGE_TEXT "Darek vaat ni nondh.$\r$\n(A note of every conversation.)$\r$\n$\r$\nNondh AI turns your voice into text in any app, records and transcribes your meetings, and lets you edit the screen recordings you make during them. Everything stays on this computer unless you choose a cloud service.$\r$\n$\r$\nDeveloped by Hemang Rathod, Full Stack Developer.$\r$\nCode. Build. Deploy. Repeat.$\r$\nhttps://hemang-rathod.vercel.app$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_PAGE_WELCOME
!macroend
