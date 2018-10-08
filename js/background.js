// stuff from https://github.com/ChristopherAkroyd/robots-txt-parser
// https://developers.google.com/webmasters/control-crawl-index/docs/robots_txt
// Constants for groupings
var USER_AGENT = 'user-agent';
var ALLOW = 'allow';
var DISALLOW = 'disallow';
var SITEMAP = 'sitemap';
var CRAWL_DELAY = 'crawl-delay';
var HOST = 'host';
// Regex's for cleaning up the file.
var comments = /#.*$/gm;
var whitespace = ' ';
var lineEndings = /[\r\n]+/g;

function cleanString(rawString) {
  // Replace comments and whitespace
  return rawString.replace(comments, '').replace(whitespace, '').trim();
}

function splitOnLines(string) {
  return string.split(lineEndings);
}

function parseRecord(line) {
  // Find first colon and assume is the field delimiter.
  var firstColonI = line.indexOf(':');
  return {
    // Fields are non-case sensitive, therefore lowercase them.
    field: line.slice(0, firstColonI).toLowerCase().trim(),
    // Values are case sensitive (e.g. urls) and therefore leave alone.
    value: line.slice(firstColonI + 1).trim(),
  };
}

function parsePattern(pattern) {
  var regexSpecialChars = /[\-\[\]\/\{\}\(\)\+\?\.\\\^\$\|]/g;
  var wildCardPattern = /\*/g;
  var EOLPattern = /\\\$$/;
  var flags = 'm';

  var regexString = pattern.replace(regexSpecialChars, '\\$&').replace(wildCardPattern, '.*').replace(EOLPattern, '$');

  return new RegExp(regexString, flags);
}

function groupMemberRecord(value) {
  return {
    specificity: value.length,
    path: parsePattern(value),
  };
}


function parser(rawString) {
  var lines = splitOnLines(cleanString(rawString));
  var robotsObj = {
    sitemaps: [],
  };
  var agent = '';
  lines.forEach(function(line) {
    var record = parseRecord(line);
    switch (record.field) {
      case USER_AGENT:
        // Bot names are non-case sensitive.
        agent = record.value = record.value.toLowerCase();
        if (agent.length > 0) {
          robotsObj[agent] = {
            allow: [],
            disallow: [],
            crawlDelay: 0,
          };
        }
        break;
      // https://developers.google.com/webmasters/control-crawl-index/docs/robots_txt#order-of-precedence-for-group-member-records
      case ALLOW:
        if (agent.length > 0 && record.value.length > 0) {
          robotsObj[agent].allow.push(groupMemberRecord(record.value));
        }
        break;
      case DISALLOW:
        if (agent.length > 0 && record.value.length > 0) {
          robotsObj[agent].disallow.push(groupMemberRecord(record.value));
        }
        break;
      // Non standard but support by google therefore included.
      case SITEMAP:
        if (record.value.length > 0) {
          robotsObj.sitemaps.push(record.value);
        }
        break;
      // @TODO test crawl delay parameter.
      case CRAWL_DELAY:
        if (agent.length > 0) {
          robotsObj[agent].crawlDelay = Number.parseInt(record.value, 10);
        }
        break;
      // Non standard but included for completeness.
      case HOST:
        if (!('host' in robotsObj)) {
          robotsObj.host = record.value;
        }
        break;
      default:
        break;
    }
  });
  // Return only unique sitemaps.
  robotsObj.sitemaps = robotsObj.sitemaps.filter(function (val, i, s) { return s.indexOf(val) === i; });
  return robotsObj;
}

function applyRecords(path, records) {
  var numApply = 0;
  var maxSpecificity = 0;

  for (var i = 0; i < records.length; i = i + 1) {
    var record = records[i];
    if (record.path.test(path)) {
      numApply = numApply + 1;
      if (record.specificity > maxSpecificity) {
        maxSpecificity = record.specificity;
      }
    }
  }

  return {
    numApply: numApply,
    maxSpecificity: maxSpecificity
  }
}

var DFLT_OPTS = {
  userAgent: '*',
  allowOnNeutral: true,
};

function Robots(opts) {
  if (!opts) {
    this.opts = DFLT_OPTS;
  } else {
    this.opts = {
      userAgent: opts.userAgent ? opts.userAgent.toLowerCase() : DFLT_OPTS.userAgent,
      allowOnNeutral: opts.allowOnNeutral ? opts.allowOnNeutral : DFLT_OPTS.allowOnNeutral
    };
  }
  this.robotsCache = {};

  this.getRecordsForAgent = function (key) {
    var domainBots = this.robotsCache[key] || {};
    var ourBotInBots = this.opts.userAgent in domainBots;
    var otherBots = '*' in domainBots;
    if (ourBotInBots) {
      return domainBots[this.opts.userAgent];
    } else if (otherBots) {
      return domainBots['*'];
    }
    return false;
  };

  this.canVisit = function (url, botGroup) {
    var allow = applyRecords(url, botGroup.allow);
    var disallow = applyRecords(url, botGroup.disallow);
    var noAllows = allow.numApply === 0 && disallow.numApply > 0;
    var noDisallows = allow.numApply > 0 && disallow.numApply === 0;

    // No rules for allow or disallow apply, therefore full allow.
    if (noAllows && noDisallows) {
      return true;
    }

    if (noDisallows || (allow.maxSpecificity > disallow.maxSpecificity)) {
      return true;
    } else if (noAllows || (allow.maxSpecificity < disallow.maxSpecificity)) {
      return false;
    }
    return this.opts.allowOnNeutral;
  };
}
Robots.prototype.setUserAgent = function setUserAgent(agent) {
  this.opts.userAgent = agent.toLowerCase();
};
Robots.prototype.setAllowOnNeutral = function setAllowOnNeutral(allow) {
  this.opts.allowOnNeutral = allow;
};

// my stuff
var cancelDefault = false;
var rob = new Robots();

var robotfilter = function (details) {

  var loc = new URL(details.url);
  if (loc.protocol == 'chrome-extension:') {
    return {cancel: false};
  }
  if (!loc.protocol.startsWith('http')) {
    return {cancel: true};
  }
  if (loc.pathname == "/robots.txt") {
    return {cancel: false};
  }
  var key = loc.protocol+'//'+loc.host;
  if (key == '')

  var timestamp = (new Date()).getTime();
  var text = '';
  var result = localStorage.getItem(key);
  var data = {};
  try {
    data = JSON.parse(result);
    if (data.status == 301) {
      return {cancel: false};
    }
    if (data.status == 302) {
      return {cancel: false};
    }
    text = data.text;
    if (data.timestamp) {
      var diff = data.timestamp - timestamp;
      if (diff > 86400000) {
        text = '';
        console.log('need to refetch robots.txt');
      }
    }
  } catch (e) {
    text = '';
  }
  if (!text) {
    var status;

    var xhttp = new XMLHttpRequest();
    xhttp.ontimeout = function(e) {
      data = {
        text: '# timeout \nUser-agent: *\nDisallow: /',
        status: 666,
        timestamp: timestamp
      };
      localStorage.setItem(key, JSON.stringify(data));
    }
    xhttp.onerror = function(e) {
      data = {
        text: '',
        status: 667,
        timestamp: timestamp
      };
      localStorage.setItem(key, JSON.stringify(data));
    }
    xhttp.onabort = function(e) {
      data = {
        text: '',
        status: 668,
        timestamp: timestamp
      };
      localStorage.setItem(key, JSON.stringify(data));
    }
    xhttp.onreadystatechange = function() {
      status = this.status;
      if (this.readyState == 4) {

        var timestamp = (new Date()).getTime();
        var data = {};
        if (this.status == 200) {
          var contentType = this.getResponseHeader("Content-Type");
          text = this.responseText,
          text = text.slice(0,5120);
          data = {
            text: text,
            contentType: contentType,
            status: this.status,
            timestamp: timestamp
          }
        } else if (this.status == 0) {
          data = {
            text: 'User-agent: *\nAllow: /',
            status: this.status,
            timestamp: timestamp
          }
        } else if (this.status == 204) {
          data = {
            text: 'User-agent: *\nAllow: /',
            status: this.status,
            timestamp: timestamp
          }
        } else if (this.status == 301) {
          data = {
            text: '',
            status: this.status,
            timestamp: timestamp
          }
        } else if (this.status == 302) {
          data = {
            text: '',
            status: this.status,
            timestamp: timestamp
          }
        } else if (this.status > 499) {
          data = {
            text: 'User-agent: *\nDisallow: /',
            status: this.status,
            timestamp: timestamp
          }
        } else if (this.status > 399) {
          data = {
            text: 'User-agent: *\nAllow: /',
            status: this.status,
            timestamp: timestamp
          }
        } else {
          data = {
            text: 'User-agent: *\nAllow: /',
            status: this.status,
            timestamp: timestamp
          }
        }
        localStorage.setItem(key, JSON.stringify(data));
      } else {
        //console.log(this.readyState, details.url);
      }
      
    };
    xhttp.open("GET", key+"/robots.txt", false);
    try {
      xhttp.send();  
    } catch (e) {
      data = {
        text: '# '+e.message,
        status: 668,
        timestamp: timestamp
      };
      localStorage.setItem(key, JSON.stringify(data));
      return {cancel: false};
    }
    

    if (status == 301) {
      return {cancel: false};
    }
    if (status == 302) {
      return {cancel: false};
    }

    rob.robotsCache[key] = parser(text);
    var botGroup = rob.getRecordsForAgent(key);
    if (botGroup) {
      var cancel = !rob.canVisit(details.url, botGroup);
    } else {
      var cancel = cancelDefault;
    }
    if (cancel) {
      if (details.tabId >= 0) {
        chrome.tabs.get(details.tabId, function(tab) {
          chrome.runtime.sendMessage({
            type: 'logline',
            blocked: cancel,
            url: details.url,
            status: status,
            timestamp: timestamp,
            tabId: details.tabId,
            tabTitle: tab.title,
            tabUrl: tab.url
          });
        });
      }
    }
    return {cancel: cancel};

  } else {
    rob.robotsCache[key] = parser(text);
    var botGroup = rob.getRecordsForAgent(key);
    if (botGroup) {
      var cancel = !rob.canVisit(details.url, botGroup);
    } else {
      var cancel = cancelDefault;
    }
    if (cancel) {
      if (details.tabId >= 0) {
        chrome.tabs.get(details.tabId, function(tab) {
          chrome.runtime.sendMessage({
            type: 'logline',
            blocked: cancel,
            url: details.url,
            status: status,
            timestamp: timestamp,
            tabId: details.tabId,
            tabTitle: tab.title,
            tabUrl: tab.url
          });
        });
      }
    }
    return {cancel: cancel};

  }

};

chrome.runtime.onMessage.addListener(function(msg) {
  if (msg.type == 'state') {
    if (msg.state) {
      init();
    } else {
      chrome.webRequest.onBeforeRequest.removeListener(robotfilter);
    }
  }
  if (msg.type == 'userAgent') {
    if (rob) {
      rob.setUserAgent(msg.userAgent);
      DFLT_OPTS.userAgent = msg.userAgent;
    } 
  }
});

function init() {
  chrome.webRequest.onBeforeRequest.addListener(
    robotfilter,
    {
      urls: ["<all_urls>"]
    },
    ["blocking"]
  );  
}
chrome.storage.local.get(['state','preferredRecordGroup'], function(result) {
  var state;
  if (result.state == undefined) {
    state = true;
    chrome.storage.local.set({state: state}, function() {
      //console.log(state);
    });
  } else {
    state = result.state;
  }
  if (result.preferredRecordGroup) {
    DFLT_OPTS.userAgent = result.preferredRecordGroup;
  }
  if (state) {
    init();
  } else {

  }
});
