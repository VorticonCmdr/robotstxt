var cachedTemplate, cached, cachedRendered;

document.addEventListener('DOMContentLoaded', function () {

  cachedTemplate = $('#cachedTemplate').html();
  Mustache.parse(cachedTemplate);
  cached = $( "#cached" );
  var keys = Object.keys(localStorage);
  var len = keys.length;
  for (var i=0; i<len; i++) {
    var obj = {
      key: keys[i]
    };
    cachedRendered = Mustache.render(cachedTemplate, obj);
    cached.append( cachedRendered );
  }

  $('#cached').change(function() {
    $('#robotstxt').val('');
    var result = localStorage.getItem(this.value);
    var text = '';
    try {
      var res = JSON.parse(result);
      text = res.text;
    } catch (e) {

    }
    $('#robotstxt').val(text);
  });

  $('#update').on('click', function(){
    var timestamp = (new Date()).getTime();
    var key = $("#cached option:selected").val();
    var text = $('#robotstxt').val();
    var data = {
      text: text,
      status: 999,
      timestamp: timestamp
    };
    localStorage.setItem(key, JSON.stringify(data));
  });
  $('#clear').on('click', function(){
    var timestamp = (new Date()).getTime();
    var key = $("#cached option:selected").val();
    $('#robotstxt').val('');
    $('#cached option:selected').remove();
    var data = {
      text: '',
      status: 999,
      timestamp: timestamp
    };
    localStorage.setItem(key, JSON.stringify(data));
  });

  $('#clearAll').on('click', function(){
    localStorage.clear();
  });

});