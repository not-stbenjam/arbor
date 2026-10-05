"use strict";

function installApplicationMenu({ app, Menu, shell, sendAction }) {
  const mac = process.platform === "darwin";
  const template = [
    ...(mac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              {
                label: "Settings…",
                accelerator: "Command+,",
                click: () => sendAction("settings"),
              },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "Refresh Worktrees",
          accelerator: "CmdOrCtrl+R",
          click: () => sendAction("refresh"),
        },
        { label: "Add SSH Host…", click: () => sendAction("add-host") },
        { label: "Statistics…", click: () => sendAction("statistics") },
        ...(!mac
          ? [
              {
                label: "Settings…",
                accelerator: "Ctrl+,",
                click: () => sendAction("settings"),
              },
            ]
          : []),
        { type: "separator" },
        mac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        {
          label: "Find Worktree",
          accelerator: "CmdOrCtrl+F",
          click: () => sendAction("focus-search"),
        },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(!app.isPackaged ? [{ role: "toggleDevTools" }] : []),
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(mac ? [{ role: "front" }] : [{ role: "close" }]),
      ],
    },
    {
      role: "help",
      submenu: [
        {
          label: "Arbor on GitHub",
          click: () =>
            shell.openExternal("https://github.com/stbenjam/arbor"),
        },
        {
          label: "Report an Issue",
          click: () =>
            shell.openExternal("https://github.com/stbenjam/arbor/issues"),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { installApplicationMenu };
