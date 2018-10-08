document.addEventListener('DOMContentLoaded', function () {

  chrome.storage.local.get(['state'], function(result) {
    var state;
    if (result.state == undefined) {
      state = true;
      chrome.storage.local.set({state: state}, function() {
        //console.log(state);
      });
    } else {
      state = result.state;
    }
    if (state) {
      $("#state").removeClass( "disabled" ).text( "active" );
      chrome.browserAction.setIcon({path: 'icons/icon48.png'});
    } else {
      $("#state").addClass( "disabled" ).text( "inactive" );
      chrome.browserAction.setIcon({path: 'icons/icon48grey.png'});
    }
  });

  document.getElementById("state").addEventListener("click", function() {

    var state = $("#state").hasClass( "disabled" );
    if ( state ) {
      $("#state").removeClass( "disabled" ).text( "active" );
      chrome.browserAction.setIcon({path: 'icons/icon48.png'});
    } else {
      $("#state").addClass( "disabled" ).text( "inactive" );
      chrome.browserAction.setIcon({path: 'icons/icon48grey.png'});
    }
    chrome.storage.local.set({state: state}, function() {
      //console.log(state);
    });
    chrome.runtime.sendMessage({
      type: 'state',
      state: state
    });

  });

  document.getElementById("logger").addEventListener("click", function() {
    chrome.tabs.create({url:'logger.html'});
  });

  document.getElementById("robots").addEventListener("click", function() {
    chrome.tabs.create({url:'robots.html'});
  });

  document.getElementById("options").addEventListener("click", function() {
    chrome.tabs.create({url:'options.html'});
  });

});