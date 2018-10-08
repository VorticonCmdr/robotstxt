var loglineTemplate, loglines, loglineRendered;
var tabTemplate, tabSelect, tabRendered;
var selectedTab;

function setupTabs() {
  var queryInfo = {
    currentWindow: true
  };

  chrome.tabs.query(queryInfo, function(tabs) {
    tabRendered = Mustache.render(tabTemplate, tabs);
    tabSelect.append( tabRendered );
  });

}


function parseMsg(msg, sender, sendResponse) {
  if (msg.type != 'logline') {
    return;
  }
  if (!selectedTab) {
    loglineRendered = Mustache.render(loglineTemplate, msg);
    loglines.append( loglineRendered );
  } else {
    if (msg.tabId == selectedTab) {
      loglineRendered = Mustache.render(loglineTemplate, msg);
      loglines.append( loglineRendered );
    }
  }
  
}

document.addEventListener('DOMContentLoaded', function () {

  tabTemplate = $('#tabTemplate').html();
  Mustache.parse(tabTemplate);
  tabSelect = $( "#tabSelect" );

  setupTabs();

  $('#tabSelect').change(function() {
    loglines.empty();
    selectedTab = $("#tabSelect option:selected").val();
  });

  loglineTemplate = $('#loglineTemplate').html();
  Mustache.parse(loglineTemplate);
  loglines = $( "#loglines" );

  chrome.runtime.onMessage.addListener(parseMsg);

});