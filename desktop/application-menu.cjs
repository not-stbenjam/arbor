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
                id: "settings",
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
          id: "refresh",
          label: "Refresh Worktrees",
          accelerator: "CmdOrCtrl+R",
          click: () => sendAction("refresh"),
        },
        {
          id: "add-host",
          label: "Add SSH Host…",
          click: () => sendAction("add-host"),
        },
        {
          id: "statistics",
          label: "Statistics…",
          click: () => sendAction("statistics"),
        },
        {
          id: "recently-deleted",
          label: "Recently Deleted…",
          click: () => sendAction("recently-deleted"),
        },
        ...(!mac
          ? [
              {
                id: "settings",
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
          id: "focus-search",
          label: "Find Worktree",
          accelerator: "CmdOrCtrl+F",
          click: () => sendAction("focus-search"),
        },
      ],
    },
    {
      label: "View",
      submenu: [
        { id: "toggle-sidebar", label: "Toggle Sidebar", accelerator: "CmdOrCtrl+B", click: () => sendAction("toggle-sidebar") },
        { type: "separator" },
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
          id: "shortcuts",
          label: "Keyboard Shortcuts",
          click: () => sendAction("shortcuts"),
        },
        { type: "separator" },
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

// The commands of Arbor's own that the window can say are unavailable just
// now: during setup, behind a dialog, or while it is deleting.
const COMMANDS = [
  "toggle-sidebar",
  "refresh",
  "add-host",
  "statistics",
  "recently-deleted",
  "settings",
  "focus-search",
  "shortcuts",
];

// Enables each command the window says can be used, and disables the rest,
// so the menu agrees with the buttons that do the same things.
function setMenuAvailability(Menu, value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid menu state");
  const menu = Menu.getApplicationMenu();
  for (const id of COMMANDS) {
    const item = menu?.getMenuItemById(id);
    if (item) item.enabled = value[id] === true;
  }
  return true;
}

module.exports = { installApplicationMenu, setMenuAvailability, COMMANDS };
