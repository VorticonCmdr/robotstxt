import $ from 'jquery';
import 'bootstrap/dist/css/bootstrap.min.css';
import greyIconUrl from '../icons/icon48grey.png?url';

document.addEventListener('DOMContentLoaded', function () {

  // Write the active tab ID to storage so the logger page can sync to it.
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (tabs[0]) chrome.storage.local.set({ loggerFocusTab: tabs[0].id });
  });

  chrome.storage.local.get(['state'], function (result) {
    var state = result.state === undefined ? true : result.state;
    if (result.state === undefined) chrome.storage.local.set({ state: true });
    document.getElementById('state').checked = state;
    chrome.action.setIcon({ path: state ? 'icons/icon48.png' : greyIconUrl });
  });

  document.getElementById('state').addEventListener('change', function () {
    var state = this.checked;
    chrome.action.setIcon({ path: state ? 'icons/icon48.png' : greyIconUrl });
    chrome.storage.local.set({ state: state });
    chrome.runtime.sendMessage({ type: 'state', state: state });
  });

  document.getElementById('logger').addEventListener('click', function () {
    chrome.tabs.create({ url: 'logger.html' });
  });

  document.getElementById('robots').addEventListener('click', function () {
    chrome.tabs.create({ url: 'robots.html' });
  });

  document.getElementById('options').addEventListener('click', function () {
    chrome.tabs.create({ url: 'options.html' });
  });

});
