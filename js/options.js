var selectedRecordGroup = '*';

document.addEventListener('DOMContentLoaded', function () {

  chrome.storage.local.get(['preferredRecordGroup'], function(result) {
    if (result.preferredRecordGroup) {
      $("#recordGroup").val(result.preferredRecordGroup);
    }
  });

  $('#recordGroup').change(function() {
    selectedRecordGroup = $("#recordGroup option:selected").val();
    chrome.storage.local.set({preferredRecordGroup: selectedRecordGroup}, function() {
      //console.log(state);
    });
    chrome.runtime.sendMessage({
      type: 'userAgent',
      state: selectedRecordGroup
    });
  });

  $('#clearAll').on('click', function(){
    localStorage.clear();
  });

});