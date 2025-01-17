import 'whatwg-fetch';

import {observe} from 'selector-observer';

import {
  SUPPORTED_LANGUAGES,
  SUPPORTED_TOOLS,
  USAGE_THRESHOLD,
  HUNDRED_PERCENT,
  MAX_DECIMALS,
  MIN_VALID_HTTP_STATUS,
  MAX_VALID_HTTP_STATUS,
  DEFAULT_LANGUAGE,
  DEFAULT_LANGUAGE_SET,
  CLONE_PROTOCOLS,
  SUFFIX_LANGUAGES
} from './constants';

import {
  getToolboxURN, getToolboxNavURN, callToolbox
} from './api/toolbox';

// eslint-disable-next-line import/no-commonjs
const gh = require('tgit-url-to-object');

const CLONE_BUTTON_GROUP_JS_CSS_CLASS = 'js-toolbox-clone-button-group';
const OPEN_BUTTON_JS_CSS_CLASS = 'js-toolbox-open-button';
const OPEN_MENU_ITEM_JS_CSS_CLASS = 'js-toolbox-open-menu-item';

const fetchMetadata = () => new Promise((resolve, reject) => {
  const metadata = gh(window.location.toString(), {enterprise: true});
  if (metadata) {
    resolve(metadata);
  } else {
    reject();
  }
});

const checkResponseStatus = response => new Promise((resolve, reject) => {
  if (response.status >= MIN_VALID_HTTP_STATUS && response.status <= MAX_VALID_HTTP_STATUS) {
    resolve(response);
  } else {
    reject();
  }
});

const parseResponse = response => new Promise((resolve, reject) => {
  response.json().then(result => {
    if (result.total_work > 0) {
      resolve(result);
    } else {
      reject();
    }
  }).catch(() => {
    reject();
  });
});

const convertBytesToPercents = languages => new Promise(resolve => {
  resolve(languages.lang_diffs.reduce((res, item) => {
    const percentFloat = item.total_work / languages.total_work * HUNDRED_PERCENT;
    const percentString = percentFloat.toFixed(MAX_DECIMALS);
    res[item.lang] = parseFloat(percentString);
    return res;
  }, {}));
});

// low-version tgit no language api, so use root html to extract languages
const extractLanguagesFromPage = tgitMetadata => new Promise(resolve => {
  fetch(tgitMetadata.clone_url).then(response => response.text()).then(htmlString => {
    const parser = new DOMParser();
    const htmlDocument = parser.parseFromString(htmlString, 'text/html');
    const languages = [...htmlDocument.querySelectorAll('.tree-item-name a')].reduce((res, item) => {
      const filename = item.innerText.replace(/\t?\n?/g, '');
      const fileSuffix = filename.match(/(?<=\.)[^.]+$/)?.[0];
      if (!fileSuffix) {
        return res;
      }
      const language = SUFFIX_LANGUAGES[fileSuffix] || fileSuffix;
      if (!language) {
        return res;
      }
      if (res[language]) {
        res[language] += USAGE_THRESHOLD;
      } else {
        res[language] = USAGE_THRESHOLD;
      }
      return res;
    }, {});
    if (languages.length === 0) {
      resolve(DEFAULT_LANGUAGE_SET);
    } else {
      resolve(languages);
    }
  }).catch(() => {
    resolve(DEFAULT_LANGUAGE_SET);
  });
});

const nowDate = () => new Date().toISOString().split('T')[0];

const fetchLanguages = tgitMetadata => new Promise(resolve => {
  fetch(`${tgitMetadata.api_url}/metrics/language_distribution?begin_date=&end_date=${nowDate()}`).
    then(checkResponseStatus).then(parseResponse).then(convertBytesToPercents).then(resolve).catch(() => {
      extractLanguagesFromPage(tgitMetadata).then(resolve);
    });
});

const selectTools = languages => new Promise(resolve => {
  const overallPoints = Object.values(languages).reduce((overall, current) => overall + current, 0);

  const filterLang = language =>
    SUPPORTED_LANGUAGES[language.toLowerCase()] && languages[language] / overallPoints > USAGE_THRESHOLD;

  const selectedToolIds = Object.keys(languages).filter(filterLang).reduce((acc, key) => {
    acc.push(...SUPPORTED_LANGUAGES[key.toLowerCase()]);
    return acc;
  }, []);

  const normalizedToolIds = selectedToolIds.length > 0
    ? Array.from(new Set(selectedToolIds))
    : SUPPORTED_LANGUAGES[DEFAULT_LANGUAGE];

  const tools = normalizedToolIds.sort().map(toolId => SUPPORTED_TOOLS[toolId]);

  resolve(tools);
});

const fetchTools = tgitMetadata => fetchLanguages(tgitMetadata).then(selectTools);

const getHttpsCloneUrl = tgitMetadata => `${tgitMetadata.clone_url}.git`;
const getSshCloneUrl = tgitMetadata => `git@${tgitMetadata.host}:${tgitMetadata.user}/${tgitMetadata.repo}.git`;

let handleMessage = null;

const renderPageAction = tgitMetadata => new Promise(resolve => {
  if (handleMessage && chrome.runtime.onMessage.hasListener(handleMessage)) {
    chrome.runtime.onMessage.removeListener(handleMessage);
  }
  handleMessage = (message, sender, sendResponse) => {
    switch (message.type) {
      case 'get-tools':
        fetchTools(tgitMetadata).then(sendResponse);
        return true;
      case 'perform-action':
        const toolboxAction = getToolboxURN(message.toolTag, message.cloneUrl);
        callToolbox(toolboxAction);
        break;
      // no default
    }
    return undefined;
  };
  chrome.runtime.onMessage.addListener(handleMessage);

  resolve();
});

const removeCloneButtons = () => {
  const cloneButtonGroup = document.querySelector(`.${CLONE_BUTTON_GROUP_JS_CSS_CLASS}`);
  if (cloneButtonGroup) {
    cloneButtonGroup.parentElement.removeChild(cloneButtonGroup);
  }
};

const addCloneButtonEventHandler = (btn, tgitMetadata) => {
  btn.addEventListener('click', e => {
    e.preventDefault();

    const {toolTag} = e.currentTarget.dataset;
    chrome.runtime.sendMessage({type: 'get-protocol'}, ({protocol}) => {
      const cloneUrl = protocol === CLONE_PROTOCOLS.HTTPS
        ? getHttpsCloneUrl(tgitMetadata)
        : getSshCloneUrl(tgitMetadata);
      const action = getToolboxURN(toolTag, cloneUrl);
      callToolbox(action);
    });
  });
};

const createCloneButton = (tool, tgitMetadata, small = true) => {
  const button = document.createElement('a');
  button.setAttribute('class',
    `btn tg-button ${small ? 'btn-sm' : 'tg-button--size-medium'} has_tooltip BtnGroup-item d-flex`);
  button.setAttribute('data-title', `Clone in ${tool.name}`);
  button.setAttribute('data-container', 'body');
  button.setAttribute('data-placement', 'bottom');
  button.setAttribute('style', 'align-items:center');
  button.dataset.toolTag = tool.tag;

  const buttonIcon = document.createElement('img');
  buttonIcon.setAttribute('alt', tool.name);
  buttonIcon.setAttribute('src', tool.icon);
  buttonIcon.setAttribute('width', '16');
  buttonIcon.setAttribute('height', '16');
  buttonIcon.setAttribute('style', 'vertical-align:text-top');
  button.appendChild(buttonIcon);

  addCloneButtonEventHandler(button, tgitMetadata);

  return button;
};

const renderCloneButtons = (tools, tgitMetadata) => {
  let getRepoController = document.querySelector('.BtnGroup + .d-flex > get-repo-controller');
  getRepoController = getRepoController
    ? getRepoController.parentElement
    : document.querySelector('.js-get-repo-select-menu');

  if (getRepoController) {
    const toolboxCloneButtonGroup = document.createElement('div');
    toolboxCloneButtonGroup.setAttribute('class', `BtnGroup ml-2 d-flex ${CLONE_BUTTON_GROUP_JS_CSS_CLASS}`);

    tools.forEach(tool => {
      const btn = createCloneButton(tool, tgitMetadata);
      toolboxCloneButtonGroup.appendChild(btn);
    });

    getRepoController.insertAdjacentElement('beforebegin', toolboxCloneButtonGroup);
  } else {
    // new UI as of 24.06.20
    getRepoController = document.querySelector('div[class="project-topics append-bottom-25"]');
    if (getRepoController) {
      const toolboxCloneButtonGroup = document.createElement('div');
      const isOnPullRequestsTab = document.querySelector('#pull-requests-tab[aria-current="page"]');
      toolboxCloneButtonGroup.setAttribute('class',
        `BtnGroup ${isOnPullRequestsTab ? 'ml-1' : 'mr-2'} d-flex ${CLONE_BUTTON_GROUP_JS_CSS_CLASS}`);
      toolboxCloneButtonGroup.setAttribute('style', 'position: relative;top: 10px;');
      tools.forEach(tool => {
        const btn = createCloneButton(tool, tgitMetadata, false);
        toolboxCloneButtonGroup.appendChild(btn);
      });

      getRepoController.insertAdjacentElement('beforebegin', toolboxCloneButtonGroup);
    }
  }
};

const addOpenButtonEventHandler = (domElement, tool, tgitMetadata) => {
  domElement.addEventListener('click', e => {
    e.preventDefault();

    const {user, repo, branch} = tgitMetadata;
    const normalizedBranch = branch.split('/').shift();
    const filePath = location.pathname.replace(`/${user}/${repo}/blob/${normalizedBranch}/`, '');
    let lineNumber = location.hash.replace('#L', '');
    if (lineNumber === '') {
      lineNumber = null;
    }

    callToolbox(getToolboxNavURN(tool.tag, repo, filePath, lineNumber));
  });
};

// when navigating with back and forward buttons
// we have to re-create open actions b/c their click handlers got lost somehow
const removeOpenButtons = () => {
  const actions = document.querySelectorAll(`.${OPEN_BUTTON_JS_CSS_CLASS}`);
  actions.forEach(action => {
    action.parentElement.removeChild(action);
  });

  const menuItems = document.querySelectorAll(`.${OPEN_MENU_ITEM_JS_CSS_CLASS}`);
  menuItems.forEach(item => {
    item.parentElement.removeChild(item);
  });
};

const removePageButtons = () => {
  removeCloneButtons();
  removeOpenButtons();
};

const createOpenButton = (tool, tgitMetadata) => {
  const action = document.createElement('a');
  action.setAttribute('class', `btn-octicon tooltipped tooltipped-nw ${OPEN_BUTTON_JS_CSS_CLASS}`);
  action.setAttribute('aria-label', `Open this file in ${tool.name}`);
  action.setAttribute('href', '#');

  const actionIcon = document.createElement('img');
  actionIcon.setAttribute('alt', tool.name);
  actionIcon.setAttribute('src', tool.icon);
  actionIcon.setAttribute('width', '16');
  actionIcon.setAttribute('height', '16');
  action.appendChild(actionIcon);

  addOpenButtonEventHandler(action, tool, tgitMetadata);

  return action;
};

const createOpenMenuItem = (tool, first, tgitMetadata) => {
  const menuItem = document.createElement('a');
  menuItem.setAttribute('class', 'dropdown-item');
  menuItem.setAttribute('role', 'menu-item');
  menuItem.setAttribute('href', '#');
  if (first) {
    menuItem.style.borderTop = '1px solid #eaecef';
  }
  menuItem.textContent = `Open in ${tool.name}`;

  addOpenButtonEventHandler(menuItem, tool, tgitMetadata);
  menuItem.addEventListener('click', () => {
    const blobToolbar = document.querySelector('.BlobToolbar');
    if (blobToolbar) {
      blobToolbar.removeAttribute('open');
    }
  });

  const menuItemContainer = document.createElement('li');
  menuItemContainer.setAttribute('class', OPEN_MENU_ITEM_JS_CSS_CLASS);
  menuItemContainer.appendChild(menuItem);

  return menuItemContainer;
};

const renderOpenButtons = (tools, tgitMetadata) => {
  const actionAnchorElement = document.querySelector('.repository-content .Box-header .BtnGroup + div');
  const actionAnchorFragment = document.createDocumentFragment();
  const blobToolbarDropdown = document.querySelector('.BlobToolbar-dropdown');

  tools.forEach((tool, toolIndex) => {
    if (actionAnchorElement) {
      const action = createOpenButton(tool, tgitMetadata);
      actionAnchorFragment.appendChild(action);
    }
    if (blobToolbarDropdown) {
      const menuItem = createOpenMenuItem(tool, toolIndex === 0, tgitMetadata);
      blobToolbarDropdown.appendChild(menuItem);
    }
  });
  if (actionAnchorElement) {
    actionAnchorElement.prepend(actionAnchorFragment);
  }
};

const renderPageButtons = tgitMetadata => {
  fetchTools(tgitMetadata).then(tools => {
    renderCloneButtons(tools, tgitMetadata);
    renderOpenButtons(tools, tgitMetadata);
  }).catch(() => {
    // do nothing
  });
};

const startTrackingDOMChanges = tgitMetadata => observe('div[class="project-topics append-bottom-25"]', {
  add() {
    removePageButtons();
    renderPageButtons(tgitMetadata);
  }, remove() {
    removePageButtons();
  }
});

const stopTrackingDOMChanges = observer => {
  if (observer) {
    observer.abort();
  }
};

const enablePageAction = tgitMetadata => {
  chrome.runtime.sendMessage({
    type: 'enable-page-action',
    project: tgitMetadata.repo,
    https: getHttpsCloneUrl(tgitMetadata),
    ssh: getSshCloneUrl(tgitMetadata)
  });
};

const disablePageAction = () => {
  chrome.runtime.sendMessage({type: 'disable-page-action'});
};

const toolboxify = () => {
  fetchMetadata().then(metadata => {
    renderPageAction(metadata).then(() => {
      enablePageAction(metadata);
    });

    chrome.runtime.sendMessage({type: 'get-modify-pages'}, data => {
      let DOMObserver = null;
      if (data.allow) {
        DOMObserver = startTrackingDOMChanges(metadata);
      }
      chrome.runtime.onMessage.addListener(message => {
        switch (message.type) {
          case 'modify-pages-changed':
            if (message.newValue) {
              DOMObserver = startTrackingDOMChanges(metadata);
            } else {
              stopTrackingDOMChanges(DOMObserver);
            }
            break;
          // no default
        }
      });
    });
  }).catch(() => {
    disablePageAction();
  });
};

export default toolboxify;
