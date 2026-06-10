// Centralised Deluge language data used by the completion and hover providers.
// Sourced from the official Zoho Deluge reference: https://www.zoho.com/deluge/help/

export interface DelugeSymbol {
    /** The text shown in the completion list / matched on hover. */
    label: string;
    /** Short one-line detail shown to the right of the label (the PRIMARY signature). */
    detail: string;
    /** Markdown documentation shown in the details pane / hover. */
    documentation: string;
    /** Optional snippet body. When omitted the label is inserted verbatim. */
    insertText?: string;
    /**
     * Additional call signatures (overloads) for this function, each a full
     * signature string in the same shape as `detail`
     * (e.g. `"list getRecords(text module, int page, int perPage)"`). The
     * signature-help popup shows ALL signatures (`detail` first, then these) and
     * auto-selects the one matching the number of arguments typed; hover lists
     * them. Sourced from the official Zoho Deluge function reference.
     */
    overloads?: string[];
}

/** All call signatures for a symbol: the primary `detail` followed by any `overloads`. */
export function allSignatures(sym: DelugeSymbol): string[] {
    return sym.overloads && sym.overloads.length ? [sym.detail, ...sym.overloads] : [sym.detail];
}

// ---------------------------------------------------------------------------
// Keywords & language constructs
// ---------------------------------------------------------------------------

export const KEYWORDS: string[] = [
    'if', 'else if', 'else', 'for each',
    'break', 'continue', 'return',
    'try', 'catch', 'throws',
    'in',
    'true', 'false', 'null'
];

export const DATA_TYPES: string[] = [
    'int', 'long', 'decimal', 'float', 'double', 'bigint',
    'string', 'text', 'bool', 'boolean',
    'list', 'map', 'key', 'collection', 'date', 'time', 'datetime', 'void', 'file', 'xml'
];

// Statement-level tasks (used standalone, not as a member call)
export const STATEMENT_TASKS: DelugeSymbol[] = [
    {
        label: 'info',
        detail: 'Log task',
        documentation: 'Prints the given value to the execution console / debug log.',
        insertText: 'info ${1:value};'
    },
    {
        label: 'sendmail',
        detail: 'Send mail task',
        documentation: 'Sends an email to the specified recipients.\n\n```deluge\nsendmail\n[\n\tfrom : zoho.adminuserid\n\tto : "${2:to@example.com}"\n\tsubject : "${3:Subject}"\n\tmessage : "${4:Body}"\n]\n```',
        insertText: 'sendmail\n[\n\tfrom : zoho.adminuserid\n\tto : "${1:to@example.com}"\n\tsubject : "${2:Subject}"\n\tmessage : "${3:Body}"\n]'
    },
    {
        label: 'invokeurl',
        detail: 'invokeUrl task — HTTP client (any REST API)',
        documentation: 'Performs an HTTP request to a third-party **or** Zoho REST API. You specify the **complete URL**; use a saved `connection` for OAuth.\n\n```deluge\nresponse = invokeurl\n[\n\turl : "https://www.zohoapis.com/crm/v3/Leads"\n\ttype : GET\n\tconnection : "crm_connection"\n];\n```',
        insertText: 'invokeurl\n[\n\turl : "${1:https://example.com/api}"\n\ttype : ${2|GET,POST,PUT,DELETE,PATCH|}\n\tconnection : "${3:connection_name}"\n]'
    },
    {
        label: 'invokeapi',
        detail: 'invokeAPI task — Zoho-to-Zoho HTTP client',
        documentation: 'Calls one Zoho service from another. Unlike `invokeurl`, you give a `service` name and a **path** (not the full URL); authentication is handled by the platform.\n\n```deluge\nresponse = invokeapi\n[\n\tservice : ZohoBookings\n\tpath : "bookings/v1/json/services"\n\ttype : GET\n\tconnection : "bookings_connection"\n];\n```',
        insertText: 'invokeapi\n[\n\tservice : ${1:ZohoCRM}\n\tpath : "${2:crm/v3/Leads}"\n\ttype : ${3|GET,POST,PUT,PATCH,DELETE|}\n\tconnection : "${4:connection_name}"\n]'
    },
    {
        label: 'openUrl',
        detail: 'Open URL task',
        documentation: 'Opens the specified URL in the same window, a new window, or a new tab.',
        insertText: 'openUrl("${1:https://example.com}", "${2|same window,new window,new tab,parent window|}");'
    },
    {
        label: 'postUrl',
        detail: 'POST request',
        documentation: 'Sends an HTTP POST request to the specified URL and returns the response.',
        insertText: 'postUrl("${1:url}", ${2:paramMap})'
    },
    {
        label: 'getUrl',
        detail: 'GET request',
        documentation: 'Sends an HTTP GET request to the specified URL and returns the response.',
        insertText: 'getUrl("${1:url}")'
    }
];

// Collection / list / map constructors used to create new values.
export const CONSTRUCTORS: DelugeSymbol[] = [
    {
        label: 'Collection',
        detail: 'Collection([values...])',
        documentation: '**Collection(...)**\n\nCreates a collection. A collection acts as *either* an index-value (list-like) *or* a key-value (map-like) structure, not both.\n\n```deluge\ngadgets = Collection("Mobile phone", "Laptop");\ndetails = Collection("Name":"Shawn", "Gender":"Male");\nempty   = Collection();\n```',
        insertText: 'Collection(${1})'
    },
    {
        label: 'Map',
        detail: 'Map()',
        documentation: '**Map()**\n\nCreates an empty key-value map. Add entries with `put(key, value)`.',
        insertText: 'Map()'
    },
    {
        label: 'List',
        detail: 'List()',
        documentation: '**List()**\n\nCreates an empty list. Add elements with `add(element)`.',
        insertText: 'List()'
    }
];

// ---------------------------------------------------------------------------
// Built-in (member) functions — invoked as `<variable>.<function>(...)`
// These are surfaced after a `.` that is not part of a `zoho.` namespace.
// ---------------------------------------------------------------------------

function fn(label: string, signature: string, doc: string, insert?: string): DelugeSymbol {
    return {
        label,
        detail: signature,
        documentation: `**${signature}**\n\n${doc}`,
        insertText: insert
    };
}

export const STRING_FUNCTIONS: DelugeSymbol[] = [
    fn('length', 'length()', 'Returns the number of characters in the text.', 'length()'),
    fn('isEmpty', 'isEmpty()', 'Returns true if the text has no characters.', 'isEmpty()'),
    fn('contains', 'contains(searchText)', 'Returns true if the text contains the given substring.', 'contains(${1:search})'),
    fn('containsIgnoreCase', 'containsIgnoreCase(searchText)', 'Case-insensitive `contains`.', 'containsIgnoreCase(${1:search})'),
    fn('startsWith', 'startsWith(prefix)', 'Returns true if the text begins with the given prefix.', 'startsWith(${1:prefix})'),
    fn('endsWith', 'endsWith(suffix)', 'Returns true if the text ends with the given suffix.', 'endsWith(${1:suffix})'),
    fn('equalsIgnoreCase', 'equalsIgnoreCase(text)', 'Case-insensitive equality check.', 'equalsIgnoreCase(${1:text})'),
    fn('indexOf', 'indexOf(searchText)', 'Returns the index of the first occurrence of the substring, or -1.', 'indexOf(${1:search})'),
    fn('lastIndexOf', 'lastIndexOf(searchText)', 'Returns the index of the last occurrence of the substring, or -1.', 'lastIndexOf(${1:search})'),
    fn('substring', 'substring(start, [end])', 'Returns the portion of text between the start and end indices.', 'substring(${1:start}, ${2:end})'),
    fn('subText', 'subText(start, [end])', 'Returns the portion of text between the start and end indices.', 'subText(${1:start}, ${2:end})'),
    fn('left', 'left(n)', 'Returns the first n characters.', 'left(${1:n})'),
    fn('right', 'right(n)', 'Returns the last n characters.', 'right(${1:n})'),
    fn('mid', 'mid(start, length)', 'Returns `length` characters starting at index `start`.', 'mid(${1:start}, ${2:length})'),
    fn('getPrefix', 'getPrefix(searchText)', 'Returns the text that appears before the given substring.', 'getPrefix(${1:search})'),
    fn('getSuffix', 'getSuffix(searchText)', 'Returns the text that appears after the given substring.', 'getSuffix(${1:search})'),
    fn('toUpperCase', 'toUpperCase()', 'Converts the text to upper case.', 'toUpperCase()'),
    fn('toLowerCase', 'toLowerCase()', 'Converts the text to lower case.', 'toLowerCase()'),
    fn('proper', 'proper()', 'Capitalises the first letter of each word.', 'proper()'),
    fn('trim', 'trim()', 'Removes leading and trailing whitespace.', 'trim()'),
    fn('replaceAll', 'replaceAll(search, replacement, [escapeRegex])', 'Replaces every occurrence of `search` with `replacement`.', 'replaceAll("${1:search}", "${2:replacement}")'),
    fn('replaceFirst', 'replaceFirst(search, replacement)', 'Replaces the first occurrence of `search`.', 'replaceFirst("${1:search}", "${2:replacement}")'),
    fn('remove', 'remove(searchText)', 'Removes every occurrence of the given substring.', 'remove(${1:search})'),
    fn('removeFirstOccurence', 'removeFirstOccurence(searchText)', 'Removes the first occurrence of the substring.', 'removeFirstOccurence(${1:search})'),
    fn('removeLastOccurence', 'removeLastOccurence(searchText)', 'Removes the last occurrence of the substring.', 'removeLastOccurence(${1:search})'),
    fn('getAlpha', 'getAlpha()', 'Returns only the alphabetic characters of the text.', 'getAlpha()'),
    fn('getAlphaNumeric', 'getAlphaNumeric()', 'Returns only the alphanumeric characters of the text.', 'getAlphaNumeric()'),
    fn('removeAllAlpha', 'removeAllAlpha()', 'Removes all alphabetic characters.', 'removeAllAlpha()'),
    fn('removeAllAlphaNumeric', 'removeAllAlphaNumeric()', 'Removes all alphanumeric characters.', 'removeAllAlphaNumeric()'),
    fn('getOccurenceCount', 'getOccurenceCount(searchText)', 'Returns how many times the substring occurs.', 'getOccurenceCount(${1:search})'),
    fn('matches', 'matches(regex)', 'Returns true if the text matches the regular expression.', 'matches("${1:regex}")'),
    fn('toList', 'toList([separator])', 'Splits the text into a list using the given separator (default comma).', 'toList("${1:,}")'),
    fn('toMap', 'toMap()', 'Parses a JSON-formatted text into a map.', 'toMap()'),
    fn('toLong', 'toLong()', 'Converts the text to a long/integer.', 'toLong()'),
    fn('toDecimal', 'toDecimal()', 'Converts the text to a decimal.', 'toDecimal()'),
    fn('toDate', 'toDate([format])', 'Parses the text into a date.', 'toDate()'),
    fn('toTime', 'toTime([format])', 'Parses the text into a date-time.', 'toTime()'),
    fn('toString', 'toString([format])', 'Converts the value to text (optionally with a format pattern).', 'toString()'),
    // -- additional text functions --
    fn('notContains', 'notContains(searchText)', 'Returns true if the text does NOT contain the substring.', 'notContains(${1:search})'),
    fn('startsWithIgnoreCase', 'startsWithIgnoreCase(prefix)', 'Case-insensitive `startsWith`.', 'startsWithIgnoreCase(${1:prefix})'),
    fn('endsWithIgnoreCase', 'endsWithIgnoreCase(suffix)', 'Case-insensitive `endsWith`.', 'endsWithIgnoreCase(${1:suffix})'),
    fn('getPrefixIgnoreCase', 'getPrefixIgnoreCase(searchText)', 'Case-insensitive `getPrefix`.', 'getPrefixIgnoreCase(${1:search})'),
    fn('getSuffixIgnoreCase', 'getSuffixIgnoreCase(searchText)', 'Case-insensitive `getSuffix`.', 'getSuffixIgnoreCase(${1:search})'),
    fn('concat', 'concat(text)', 'Appends the given text to the end of this text.', 'concat(${1:text})'),
    fn('ltrim', 'ltrim()', 'Removes leading whitespace.', 'ltrim()'),
    fn('rtrim', 'rtrim()', 'Removes trailing whitespace.', 'rtrim()'),
    fn('leftpad', 'leftpad(length)', 'Pads the text on the left to the given length.', 'leftpad(${1:length})'),
    fn('rightpad', 'rightpad(length)', 'Pads the text on the right to the given length.', 'rightpad(${1:length})'),
    fn('reverse', 'reverse()', 'Reverses the order of characters.', 'reverse()'),
    fn('repeat', 'repeat(n)', 'Repeats the text n times.', 'repeat(${1:n})'),
    fn('replaceAllIgnoreCase', 'replaceAllIgnoreCase(search, replacement)', 'Case-insensitive `replaceAll`.', 'replaceAllIgnoreCase("${1:search}", "${2:replacement}")'),
    fn('replaceFirstIgnoreCase', 'replaceFirstIgnoreCase(search, replacement)', 'Case-insensitive `replaceFirst`.', 'replaceFirstIgnoreCase("${1:search}", "${2:replacement}")'),
    fn('find', 'find(searchText, [from])', 'Returns the position of the substring (optionally from an index).', 'find(${1:search})'),
    fn('len', 'len()', 'Returns the number of characters (alias of `length`).', 'len()'),
    fn('toNumber', 'toNumber()', 'Converts the text to a number.', 'toNumber()'),
    fn('toText', 'toText()', 'Converts the value to text.', 'toText()'),
    fn('toJSONList', 'toJSONList()', 'Parses a JSON-array text into a list.', 'toJSONList()'),
    fn('toListString', 'toListString()', 'Converts comma-separated text into a list.', 'toListString()'),
    fn('hexToText', 'hexToText()', 'Decodes a hexadecimal string into text.', 'hexToText()'),
    fn('textToHex', 'textToHex()', 'Encodes text into a hexadecimal string.', 'textToHex()'),
    fn('isAscii', 'isAscii()', 'Returns true if all characters are ASCII.', 'isAscii()'),
    fn('isText', 'isText()', 'Returns true if the value is of text/string type.', 'isText()'),
    fn('toXml', 'toXml()', 'Converts the value into XML.', 'toXml()'),
    fn('toXmlList', 'toXmlList()', 'Converts the value into a list of XML nodes.', 'toXmlList()')
];

export const NUMBER_FUNCTIONS: DelugeSymbol[] = [
    fn('abs', 'abs()', 'Returns the absolute value.', 'abs()'),
    fn('ceil', 'ceil()', 'Rounds up to the nearest integer.', 'ceil()'),
    fn('floor', 'floor()', 'Rounds down to the nearest integer.', 'floor()'),
    fn('round', 'round([precision])', 'Rounds to the given number of decimal places.', 'round(${1:2})'),
    fn('power', 'power(exponent)', 'Raises the number to the given power.', 'power(${1:exponent})'),
    fn('sqrt', 'sqrt()', 'Returns the square root.', 'sqrt()'),
    fn('exp', 'exp()', 'Returns e raised to the number.', 'exp()'),
    fn('log', 'log()', 'Returns the natural logarithm.', 'log()'),
    fn('sin', 'sin()', 'Trigonometric sine.', 'sin()'),
    fn('cos', 'cos()', 'Trigonometric cosine.', 'cos()'),
    fn('tan', 'tan()', 'Trigonometric tangent.', 'tan()'),
    fn('toDecimal', 'toDecimal()', 'Converts to a decimal value.', 'toDecimal()'),
    fn('toLong', 'toLong()', 'Converts to a long/integer value.', 'toLong()'),
    // -- additional number functions --
    fn('log10', 'log10()', 'Returns the base-10 logarithm.', 'log10()'),
    fn('frac', 'frac()', 'Returns the fractional part of the number.', 'frac()'),
    fn('asin', 'asin()', 'Arc sine.', 'asin()'),
    fn('acos', 'acos()', 'Arc cosine.', 'acos()'),
    fn('atan', 'atan()', 'Arc tangent.', 'atan()'),
    fn('atan2', 'atan2(x)', 'Arc tangent of y/x.', 'atan2(${1:x})'),
    fn('sinh', 'sinh()', 'Hyperbolic sine.', 'sinh()'),
    fn('cosh', 'cosh()', 'Hyperbolic cosine.', 'cosh()'),
    fn('tanh', 'tanh()', 'Hyperbolic tangent.', 'tanh()'),
    fn('min', 'min(number)', 'Returns the smaller of two numbers.', 'min(${1:number})'),
    fn('max', 'max(number)', 'Returns the larger of two numbers.', 'max(${1:number})'),
    fn('randomNumber', 'randomNumber([min], [max])', 'Returns a random number, optionally within a range.', 'randomNumber()'),
    fn('isNumber', 'isNumber()', 'Returns true if the value is a number.', 'isNumber()'),
    fn('toHex', 'toHex()', 'Converts the number to a hexadecimal string.', 'toHex()'),
    fn('toWords', 'toWords()', 'Spells the number out in words.', 'toWords()'),
    fn('toString', 'toString([format])', 'Converts the number to text, optionally with a format pattern.', 'toString()')
];

export const DATETIME_FUNCTIONS: DelugeSymbol[] = [
    fn('addDay', 'addDay(n)', 'Returns the date with n days added.', 'addDay(${1:n})'),
    fn('subDay', 'subDay(n)', 'Returns the date with n days subtracted.', 'subDay(${1:n})'),
    fn('addWeek', 'addWeek(n)', 'Returns the date with n weeks added.', 'addWeek(${1:n})'),
    fn('subWeek', 'subWeek(n)', 'Returns the date with n weeks subtracted.', 'subWeek(${1:n})'),
    fn('addMonth', 'addMonth(n)', 'Returns the date with n months added.', 'addMonth(${1:n})'),
    fn('subMonth', 'subMonth(n)', 'Returns the date with n months subtracted.', 'subMonth(${1:n})'),
    fn('addYear', 'addYear(n)', 'Returns the date with n years added.', 'addYear(${1:n})'),
    fn('subYear', 'subYear(n)', 'Returns the date with n years subtracted.', 'subYear(${1:n})'),
    fn('addHour', 'addHour(n)', 'Returns the date-time with n hours added.', 'addHour(${1:n})'),
    fn('addMinutes', 'addMinutes(n)', 'Returns the date-time with n minutes added.', 'addMinutes(${1:n})'),
    fn('addSeconds', 'addSeconds(n)', 'Returns the date-time with n seconds added.', 'addSeconds(${1:n})'),
    fn('getDay', 'getDay()', 'Returns the day of the month (1–31).', 'getDay()'),
    fn('getMonth', 'getMonth()', 'Returns the month (1–12).', 'getMonth()'),
    fn('getYear', 'getYear()', 'Returns the year.', 'getYear()'),
    fn('getHour', 'getHour()', 'Returns the hour of the day.', 'getHour()'),
    fn('getMinutes', 'getMinutes()', 'Returns the minutes.', 'getMinutes()'),
    fn('getSeconds', 'getSeconds()', 'Returns the seconds.', 'getSeconds()'),
    fn('weekday', 'weekday()', 'Returns the day of the week as a number (1–7), e.g. `zoho.currentdate.weekday()`.', 'weekday()'),
    fn('getDayOfYear', 'getDayOfYear()', 'Returns the day of the year (1–366).', 'getDayOfYear()'),
    fn('getWeekOfYear', 'getWeekOfYear()', 'Returns the week of the year (1–53).', 'getWeekOfYear()'),
    fn('daysBetween', 'daysBetween(date)', 'Returns the number of days between two dates.', 'daysBetween(${1:date})'),
    fn('hoursBetween', 'hoursBetween(date)', 'Returns the number of hours between two date-times.', 'hoursBetween(${1:date})'),
    fn('monthsBetween', 'monthsBetween(date)', 'Returns the number of months between two dates.', 'monthsBetween(${1:date})'),
    fn('yearsBetween', 'yearsBetween(date)', 'Returns the number of years between two dates.', 'yearsBetween(${1:date})'),
    fn('toStartOfMonth', 'toStartOfMonth()', 'Returns the first day of the month.', 'toStartOfMonth()'),
    fn('toStartOfWeek', 'toStartOfWeek()', 'Returns the first day of the week.', 'toStartOfWeek()'),
    fn('toString', 'toString(format)', 'Formats the date-time using the given pattern, e.g. "dd-MMM-yyyy".', 'toString("${1:dd-MMM-yyyy}")'),
    // -- additional date-time functions --
    fn('subHour', 'subHour(n)', 'Returns the date-time with n hours subtracted.', 'subHour(${1:n})'),
    fn('subMinutes', 'subMinutes(n)', 'Returns the date-time with n minutes subtracted.', 'subMinutes(${1:n})'),
    fn('subSeconds', 'subSeconds(n)', 'Returns the date-time with n seconds subtracted.', 'subSeconds(${1:n})'),
    fn('addBusinessDay', 'addBusinessDay(n)', 'Adds n business (working) days.', 'addBusinessDay(${1:n})'),
    fn('subBusinessDay', 'subBusinessDay(n)', 'Subtracts n business (working) days.', 'subBusinessDay(${1:n})'),
    fn('day', 'day()', 'Returns the day of the month (alias of `getDay`).', 'day()'),
    fn('hour', 'hour()', 'Returns the hour (alias of `getHour`).', 'hour()'),
    fn('minute', 'minute()', 'Returns the minutes (alias of `getMinutes`).', 'minute()'),
    fn('month', 'month()', 'Returns the month (alias of `getMonth`).', 'month()'),
    fn('second', 'second()', 'Returns the seconds (alias of `getSeconds`).', 'second()'),
    fn('days360', 'days360(date)', 'Days between two dates using the 360-day calendar.', 'days360(${1:date})'),
    fn('edate', 'edate(months)', 'Returns the date n months before/after this date.', 'edate(${1:months})'),
    fn('eomonth', 'eomonth(months)', 'Returns the last day of the month n months away.', 'eomonth(${1:months})'),
    fn('totalMonth', 'totalMonth(date)', 'Total whole months between two dates.', 'totalMonth(${1:date})'),
    fn('totalYear', 'totalYear(date)', 'Total whole years between two dates.', 'totalYear(${1:date})'),
    fn('workday', 'workday(days)', 'Returns the working day n days from this date.', 'workday(${1:days})'),
    fn('nextWeekDay', 'nextWeekDay()', 'Returns the next working day.', 'nextWeekDay()'),
    fn('previousWeekDay', 'previousWeekDay()', 'Returns the previous working day.', 'previousWeekDay()'),
    fn('isDate', 'isDate([format])', 'Returns true if the text is a valid date.', 'isDate()'),
    fn('toDate', 'toDate([format])', 'Converts the value to a date.', 'toDate()'),
    fn('toTime', 'toTime([format])', 'Converts the value to a date-time.', 'toTime()'),
    fn('toDateTimeString', 'toDateTimeString()', 'Returns the standard date-time string form.', 'toDateTimeString()'),
    fn('unixEpoch', 'unixEpoch()', 'Returns the Unix epoch (milliseconds) for the date-time.', 'unixEpoch()'),
    fn('now', 'now()', 'Returns the current date-time.', 'now()'),
    fn('today', 'today()', 'Returns the current date.', 'today()')
];

export const LIST_FUNCTIONS: DelugeSymbol[] = [
    fn('add', 'add(element)', 'Appends an element to the list.', 'add(${1:element})'),
    fn('addAll', 'addAll(list)', 'Appends all elements of another list.', 'addAll(${1:list})'),
    fn('get', 'get(index)', 'Returns the element at the given index.', 'get(${1:index})'),
    fn('size', 'size()', 'Returns the number of elements.', 'size()'),
    fn('isEmpty', 'isEmpty()', 'Returns true if the list has no elements.', 'isEmpty()'),
    fn('contains', 'contains(element)', 'Returns true if the element is present.', 'contains(${1:element})'),
    fn('indexOf', 'indexOf(element)', 'Returns the index of the first occurrence, or -1.', 'indexOf(${1:element})'),
    fn('lastIndexOf', 'lastIndexOf(element)', 'Returns the index of the last occurrence, or -1.', 'lastIndexOf(${1:element})'),
    fn('remove', 'remove(index)', 'Removes the element at the given index.', 'remove(${1:index})'),
    fn('removeElement', 'removeElement(element)', 'Removes the first matching element.', 'removeElement(${1:element})'),
    fn('removeAll', 'removeAll(list)', 'Removes all elements present in the given list.', 'removeAll(${1:list})'),
    fn('clear', 'clear()', 'Removes all elements.', 'clear()'),
    fn('sort', 'sort([ascending])', 'Returns a sorted copy of the list.', 'sort(${1|true,false|})'),
    fn('distinct', 'distinct()', 'Returns the list with duplicates removed.', 'distinct()'),
    fn('subList', 'subList(start, [end])', 'Returns a portion of the list.', 'subList(${1:start}, ${2:end})'),
    fn('intersect', 'intersect(list)', 'Returns the elements common to both lists.', 'intersect(${1:list})'),
    fn('toJSONList', 'toJSONList()', 'Converts the list into a JSON array.', 'toJSONList()'),
    // -- additional list functions --
    fn('notContains', 'notContains(element)', 'Returns true if the element is NOT present.', 'notContains(${1:element})'),
    fn('toList', 'toList()', 'Returns the value as a list.', 'toList()'),
    fn('average', 'average()', 'Returns the average of a numeric list.', 'average()'),
    fn('median', 'median()', 'Returns the median of a numeric list.', 'median()'),
    fn('largest', 'largest()', 'Returns the largest element.', 'largest()'),
    fn('smallest', 'smallest()', 'Returns the smallest element.', 'smallest()'),
    fn('nthLargest', 'nthLargest(n)', 'Returns the nth-largest element.', 'nthLargest(${1:n})'),
    fn('nthSmallest', 'nthSmallest(n)', 'Returns the nth-smallest element.', 'nthSmallest(${1:n})')
];

export const MAP_FUNCTIONS: DelugeSymbol[] = [
    fn('put', 'put(key, value)', 'Inserts or updates a key-value pair.', 'put(${1:key}, ${2:value})'),
    fn('putAll', 'putAll(map)', 'Inserts all key-value pairs of another map.', 'putAll(${1:map})'),
    fn('get', 'get(key)', 'Returns the value for the given key.', 'get(${1:key})'),
    fn('size', 'size()', 'Returns the number of key-value pairs.', 'size()'),
    fn('isEmpty', 'isEmpty()', 'Returns true if the map has no entries.', 'isEmpty()'),
    fn('containKey', 'containKey(key)', 'Returns true if the key exists.', 'containKey(${1:key})'),
    fn('containValue', 'containValue(value)', 'Returns true if the value exists.', 'containValue(${1:value})'),
    fn('keys', 'keys()', 'Returns all keys as a list.', 'keys()'),
    fn('remove', 'remove(key)', 'Removes the entry for the given key.', 'remove(${1:key})'),
    fn('clear', 'clear()', 'Removes all entries.', 'clear()'),
    fn('toString', 'toString()', 'Converts the map into a JSON-formatted text.', 'toString()'),
    // -- additional map functions --
    fn('toMap', 'toMap()', 'Converts the value into a map.', 'toMap()'),
    fn('toJSONList', 'toJSONList()', 'Converts the map entries into a JSON list.', 'toJSONList()'),
    fn('notContains', 'notContains(value)', 'Returns true if the value is NOT present.', 'notContains(${1:value})')
];

// File functions — operate on a FILE value (`<file>.<function>(...)`).
export const FILE_FUNCTIONS: DelugeSymbol[] = [
    fn('getFileContent', 'getFileContent()', 'Returns the content of the file object.', 'getFileContent()'),
    fn('getFileName', 'getFileName()', 'Returns the name of the file.', 'getFileName()'),
    fn('getFileSize', 'getFileSize()', 'Returns the size of the file in bytes.', 'getFileSize()'),
    fn('getFileType', 'getFileType()', 'Returns the type/format of the file.', 'getFileType()'),
    fn('isFile', 'isFile()', 'Returns true if the value is a file object.', 'isFile()'),
    fn('setFileName', 'setFileName(name)', 'Sets the name of the file object.', 'setFileName("${1:name}")'),
    fn('setFileType', 'setFileType(type)', 'Sets the type/format of the file object.', 'setFileType("${1:pdf}")'),
    fn('setCharset', 'setCharset(charset)', 'Sets the character encoding of the file.', 'setCharset("${1:UTF-8}")'),
    fn('compress', 'compress([fileName])', 'Compresses the file (e.g. into a zip archive).', 'compress()'),
    fn('extract', 'extract()', 'Extracts the contents of a compressed file.', 'extract()'),
    fn('toFile', 'toFile([fileName])', 'Converts the value (text/blob) into a file object.', 'toFile()'),
    fn('convertToPDF', 'convertToPDF()', 'Converts the file into a PDF.', 'convertToPDF()')
];

// Collection functions — operate on a Collection value (list-like or map-like).
export const COLLECTION_FUNCTIONS: DelugeSymbol[] = [
    fn('insert', 'insert(value) / insert(key:value)', 'Inserts an element (index-value) or a key-value pair.', 'insert(${1:value})'),
    fn('insertAll', 'insertAll(collection)', 'Inserts all elements/pairs from another collection.', 'insertAll(${1:collection})'),
    fn('get', 'get(index|key)', 'Returns the value at an index or for a key.', 'get(${1:indexOrKey})'),
    fn('getKey', 'getKey(index)', 'Returns the key at the given position.', 'getKey(${1:index})'),
    fn('getLastKey', 'getLastKey()', 'Returns the last key in the collection.', 'getLastKey()'),
    fn('update', 'update(key, value)', 'Updates the value for an existing key/index.', 'update(${1:key}, ${2:value})'),
    fn('delete', 'delete(value)', 'Removes the given value.', 'delete(${1:value})'),
    fn('deleteAll', 'deleteAll(collection)', 'Removes all given values.', 'deleteAll(${1:collection})'),
    fn('deleteKey', 'deleteKey(key)', 'Removes the entry for the given key.', 'deleteKey(${1:key})'),
    fn('deleteKeys', 'deleteKeys(keys)', 'Removes entries for the given keys.', 'deleteKeys(${1:keys})'),
    fn('keys', 'keys()', 'Returns all keys as a list.', 'keys()'),
    fn('values', 'values()', 'Returns all values as a list.', 'values()'),
    fn('containsKey', 'containsKey(key)', 'Returns true if the key exists.', 'containsKey(${1:key})'),
    fn('containsValue', 'containsValue(value)', 'Returns true if the value exists.', 'containsValue(${1:value})'),
    fn('size', 'size()', 'Returns the number of elements/pairs.', 'size()'),
    fn('isEmpty', 'isEmpty()', 'Returns true if the collection is empty.', 'isEmpty()'),
    fn('sort', 'sort([ascending])', 'Sorts the collection by value.', 'sort(${1|true,false|})'),
    fn('sortKey', 'sortKey([ascending])', 'Sorts the collection by key.', 'sortKey(${1|true,false|})'),
    fn('distinct', 'distinct()', 'Returns unique elements.', 'distinct()'),
    fn('intersect', 'intersect(collection)', 'Returns elements common to both collections.', 'intersect(${1:collection})'),
    fn('duplicate', 'duplicate()', 'Returns a copy of the collection.', 'duplicate()'),
    fn('clear', 'clear()', 'Removes all elements/pairs.', 'clear()'),
    fn('notContains', 'notContains(value)', 'Returns true if the value is NOT present.', 'notContains(${1:value})')
];

// Logical / null-check functions. `isNull` and `isBlank` support member-style
// invocation (`<expr>.isNull()`); `ifNull` is a standalone two-argument function.
// Verified: https://www.zoho.com/deluge/help/functions/logical.html
export const LOGICAL_FUNCTIONS: DelugeSymbol[] = [
    fn('isNull', 'isNull()', 'Returns true if the value is null. Also usable standalone as `isNull(expression)`.', 'isNull()'),
    fn('isBlank', 'isBlank()', 'Returns true if the value is blank (null or empty text). Also usable standalone as `isBlank(expression)`.', 'isBlank()'),
    {
        label: 'ifNull',
        detail: 'ifNull(expression1, expression2)',
        documentation: '**ifNull(expression1, expression2)**\n\nReturns `expression1` when it is not null; otherwise returns `expression2`.\n\nVerified: https://www.zoho.com/deluge/help/functions/logical.html',
        insertText: 'ifNull(${1:expression1}, ${2:expression2})'
    }
];

// Encryption / hashing / encoding tasks — invoked as `zoho.encryption.<task>(...)`.
// These are namespace tasks (like the CRM tasks), not value member functions.
// Verified against https://www.zoho.com/deluge/help/encryption-tasks.html and the
// individual function pages under https://www.zoho.com/deluge/help/functions/encryption/.
// NOTE on casing: AES / Base64 / Base32 / URL tasks are camelCase, while the
// HMAC and SHA/MD5 hashing tasks use all-lowercase names (e.g. `hmacsha256`, `sha256`).
export const ENCRYPTION_FUNCTIONS: DelugeSymbol[] = [
    {
        label: 'zoho.encryption.base64Encode',
        detail: 'base64Encode(data, [destinationCharset])',
        documentation: '**zoho.encryption.base64Encode(data, [destinationCharset])**\n\nEncodes the given text or file into Base64. `destinationCharset` is optional (UTF-8 default; also UTF-16LE / UTF-16BE).\n\nVerified: https://www.zoho.com/deluge/help/functions/encryption/base64encode.html',
        insertText: 'zoho.encryption.base64Encode(${1:data})'
    },
    {
        label: 'zoho.encryption.base64Decode',
        detail: 'base64Decode(data, [sourceCharset])',
        documentation: '**zoho.encryption.base64Decode(data, [sourceCharset])**\n\nDecodes a Base64-encoded text. `sourceCharset` is optional (UTF-8 default; also UTF-16LE / UTF-16BE).\n\nVerified: https://www.zoho.com/deluge/help/functions/encryption/base64decode.html',
        insertText: 'zoho.encryption.base64Decode(${1:data})'
    },
    {
        label: 'zoho.encryption.base64DecodeToFile',
        detail: 'base64DecodeToFile(data)',
        documentation: '**zoho.encryption.base64DecodeToFile(data)**\n\nDecodes a Base64-encoded text and returns the result as a file object.\n\nVerified: https://www.zoho.com/deluge/help/encryption-tasks.html',
        insertText: 'zoho.encryption.base64DecodeToFile(${1:data})'
    },
    {
        label: 'zoho.encryption.base32Encode',
        detail: 'base32Encode(data)',
        documentation: '**zoho.encryption.base32Encode(data)**\n\nEncodes the given text into Base32.\n\nVerified: https://www.zoho.com/deluge/help/encryption-tasks.html',
        insertText: 'zoho.encryption.base32Encode(${1:data})'
    },
    {
        label: 'zoho.encryption.base32Decode',
        detail: 'base32Decode(data)',
        documentation: '**zoho.encryption.base32Decode(data)**\n\nDecodes a Base32-encoded text.\n\nVerified: https://www.zoho.com/deluge/help/encryption-tasks.html',
        insertText: 'zoho.encryption.base32Decode(${1:data})'
    },
    {
        label: 'zoho.encryption.aesEncode',
        detail: 'aesEncode(encryptionKey, encryptionValue, [iv])',
        documentation: '**zoho.encryption.aesEncode(encryptionKey, encryptionValue, [iv])**\n\nEncrypts the given text using AES. `iv` is an optional 16-character initialization vector.\n\nVerified: https://www.zoho.com/deluge/help/functions/encryption/aesencode.html',
        insertText: 'zoho.encryption.aesEncode(${1:encryptionKey}, ${2:encryptionValue})'
    },
    {
        label: 'zoho.encryption.aesDecode',
        detail: 'aesDecode(encryptionKey, encryptedValue, [iv])',
        documentation: '**zoho.encryption.aesDecode(encryptionKey, encryptedValue, [iv])**\n\nDecrypts an AES-encrypted text. `iv` is an optional 16-character initialization vector.\n\nVerified: https://www.zoho.com/deluge/help/encryption-tasks.html',
        insertText: 'zoho.encryption.aesDecode(${1:encryptionKey}, ${2:encryptedValue})'
    },
    {
        label: 'zoho.encryption.aesEncode128',
        detail: 'aesEncode128(encryptionKey, encryptionValue)',
        documentation: '**zoho.encryption.aesEncode128(encryptionKey, encryptionValue)**\n\nEncrypts the given text using 128-bit AES.\n\nVerified: https://www.zoho.com/deluge/help/functions/encryption/aesencode128.html',
        insertText: 'zoho.encryption.aesEncode128(${1:encryptionKey}, ${2:encryptionValue})'
    },
    {
        label: 'zoho.encryption.aesDecode128',
        detail: 'aesDecode128(encryptionKey, encryptedValue)',
        documentation: '**zoho.encryption.aesDecode128(encryptionKey, encryptedValue)**\n\nDecrypts a 128-bit AES-encrypted text.\n\nVerified: https://www.zoho.com/deluge/help/encryption-tasks.html',
        insertText: 'zoho.encryption.aesDecode128(${1:encryptionKey}, ${2:encryptedValue})'
    },
    {
        label: 'zoho.encryption.hmacsha1',
        detail: 'hmacsha1(key, data, [outputType])',
        documentation: '**zoho.encryption.hmacsha1(key, data, [outputType])**\n\nReturns the HMAC-SHA1 hash of `data` using the secret `key`. `outputType` is optional ("base64" default, or "hex").\n\nVerified: https://www.zoho.com/deluge/help/encryption/hmac-sha1.html',
        insertText: 'zoho.encryption.hmacsha1(${1:key}, ${2:data})'
    },
    {
        label: 'zoho.encryption.hmacsha256',
        detail: 'hmacsha256(key, data, [outputType])',
        documentation: '**zoho.encryption.hmacsha256(key, data, [outputType])**\n\nReturns the HMAC-SHA256 hash of `data` using the secret `key`. `outputType` is optional ("base64" default, "hex", or "binary").\n\nVerified: https://www.zoho.com/deluge/help/encryption/hmac-sha256.html',
        insertText: 'zoho.encryption.hmacsha256(${1:key}, ${2:data})'
    },
    {
        label: 'zoho.encryption.hmacsha512',
        detail: 'hmacsha512(key, data, [outputType])',
        documentation: '**zoho.encryption.hmacsha512(key, data, [outputType])**\n\nReturns the HMAC-SHA512 hash of `data` using the secret `key`. `outputType` is optional.\n\nVerified: https://www.zoho.com/deluge/help/encryption/hmac-sha512.html',
        insertText: 'zoho.encryption.hmacsha512(${1:key}, ${2:data})'
    },
    {
        label: 'zoho.encryption.md5',
        detail: 'md5(data)',
        documentation: '**zoho.encryption.md5(data)**\n\nReturns the MD5 hash of the given text.\n\nVerified: https://www.zoho.com/deluge/help/encryption/md5.html',
        insertText: 'zoho.encryption.md5(${1:data})'
    },
    {
        label: 'zoho.encryption.sha1',
        detail: 'sha1(data)',
        documentation: '**zoho.encryption.sha1(data)**\n\nReturns the SHA1 hash of the given text.\n\nVerified: https://www.zoho.com/deluge/help/encryption-tasks.html',
        insertText: 'zoho.encryption.sha1(${1:data})'
    },
    {
        label: 'zoho.encryption.sha256',
        detail: 'sha256(data, [outputType])',
        documentation: '**zoho.encryption.sha256(data, [outputType])**\n\nReturns the SHA256 hash of the given text. `outputType` is optional ("hex" default, or "binary").\n\nVerified: https://www.zoho.com/deluge/help/encryption/sha256.html',
        insertText: 'zoho.encryption.sha256(${1:data})'
    },
    {
        label: 'zoho.encryption.sha512',
        detail: 'sha512(data)',
        documentation: '**zoho.encryption.sha512(data)**\n\nReturns the SHA512 hash of the given text.\n\nVerified: https://www.zoho.com/deluge/help/encryption/sha512.html',
        insertText: 'zoho.encryption.sha512(${1:data})'
    },
    {
        label: 'zoho.encryption.urlEncode',
        detail: 'urlEncode(string)',
        documentation: '**zoho.encryption.urlEncode(string)**\n\nURL-encodes the given text (spaces become `%20`). Returns null for non-text input.\n\nVerified: https://www.zoho.com/deluge/help/functions/encryption/urlencode.html',
        insertText: 'zoho.encryption.urlEncode(${1:string})'
    },
    {
        label: 'zoho.encryption.urlDecode',
        detail: 'urlDecode(string)',
        documentation: '**zoho.encryption.urlDecode(string)**\n\nDecodes a URL-encoded text.\n\nVerified: https://www.zoho.com/deluge/help/functions/encryption/urldecode.html',
        insertText: 'zoho.encryption.urlDecode(${1:string})'
    }
];

/** Built-in member functions surfaced after a `.` on a variable. De-duplicated by label. */
export const MEMBER_FUNCTIONS: DelugeSymbol[] = (() => {
    const all = [
        ...STRING_FUNCTIONS,
        ...NUMBER_FUNCTIONS,
        ...DATETIME_FUNCTIONS,
        ...LIST_FUNCTIONS,
        ...MAP_FUNCTIONS,
        ...COLLECTION_FUNCTIONS,
        ...FILE_FUNCTIONS,
        ...LOGICAL_FUNCTIONS
        // NOTE: ENCRYPTION_FUNCTIONS are `zoho.encryption.*` tasks, not member
        // functions — they belong under the `zoho.` chain, not after a `.` on a
        // variable, so they are intentionally excluded here.
    ];
    const seen = new Set<string>();
    const result: DelugeSymbol[] = [];
    for (const sym of all) {
        const key = sym.label + '|' + sym.detail;
        if (!seen.has(key)) {
            seen.add(key);
            result.push(sym);
        }
    }
    return result;
})();

// ---------------------------------------------------------------------------
// Integration tasks — invoked as `zoho.<service>.<action>(...)`
// ---------------------------------------------------------------------------

/** Zoho service namespaces available under the `zoho.` root. */
export const ZOHO_NAMESPACES: string[] = [
    'crm', 'creator', 'books', 'invoice', 'inventory', 'billing', 'subscriptions',
    'desk', 'projects', 'people', 'recruit', 'analytics', 'bookings', 'calendar',
    'cliq', 'connect', 'mail', 'sheet', 'sign', 'workdrive', 'writer', 'salesiq',
    'notebook', 'sdp', 'map', 'encryption',
    // Bigin exposes a documented `zoho.bigin.*` integration-task namespace
    // (https://www.bigin.com/developer/docs/DRE/library.html).
    'bigin'
];

/** Zoho system / global variables exposed under the `zoho.` root. */
export const ZOHO_VARIABLES: DelugeSymbol[] = [
    fn('loginuser', 'zoho.loginuser', 'Email address of the user currently logged in.'),
    fn('loginuserid', 'zoho.loginuserid', 'ID of the user currently logged in.'),
    fn('adminuser', 'zoho.adminuser', 'Email address of the super admin.'),
    fn('adminuserid', 'zoho.adminuserid', 'ID of the super admin.'),
    fn('currentdate', 'zoho.currentdate', 'The current date.'),
    fn('currenttime', 'zoho.currenttime', 'The current date and time.'),
    fn('appuri', 'zoho.appuri', 'The application URI.')
];

export const CRM_FUNCTIONS: DelugeSymbol[] = [
    {
        label: 'zoho.crm.getRecordById',
        detail: 'getRecordById(module, recordId)',
        documentation: '**zoho.crm.getRecordById(module, recordId)**\n\nFetches a single record from a CRM module by its ID.\n\n*Returns*: a map of the record’s fields.',
        insertText: 'zoho.crm.getRecordById("${1:Module}", ${2:recordId})'
    },
    {
        label: 'zoho.crm.getRecords',
        detail: 'getRecords(module, [page], [perPage])',
        documentation: '**zoho.crm.getRecords(module, [page], [perPage])**\n\nFetches a page of records from a CRM module.\n\n*Returns*: a list of record maps.',
        insertText: 'zoho.crm.getRecords("${1:Module}")'
    },
    {
        label: 'zoho.crm.searchRecords',
        detail: 'searchRecords(module, criteria, [page], [perPage])',
        documentation: '**zoho.crm.searchRecords(module, criteria, [page], [perPage])**\n\nSearches a module using a COQL-style criteria string, e.g. `(Email:equals:a@b.com)`.\n\n*Returns*: a list of matching record maps.',
        insertText: 'zoho.crm.searchRecords("${1:Module}", "${2:(Field:equals:value)}")'
    },
    {
        label: 'zoho.crm.getRelatedRecords',
        detail: 'getRelatedRecords(relatedModule, module, recordId)',
        documentation: '**zoho.crm.getRelatedRecords(relatedModule, parentModule, recordId)**\n\nFetches records related to a parent record.\n\n*Returns*: a list of related record maps.',
        insertText: 'zoho.crm.getRelatedRecords("${1:RelatedModule}", "${2:Module}", ${3:recordId})'
    },
    {
        label: 'zoho.crm.createRecord',
        detail: 'createRecord(module, recordMap)',
        documentation: '**zoho.crm.createRecord(module, recordMap)**\n\nCreates a record in the specified module.\n\n*Returns*: a map of the created record including its new ID.',
        insertText: 'zoho.crm.createRecord("${1:Module}", ${2:recordMap})'
    },
    {
        label: 'zoho.crm.updateRecord',
        detail: 'updateRecord(module, recordId, recordMap)',
        documentation: '**zoho.crm.updateRecord(module, recordId, recordMap)**\n\nUpdates an existing record.\n\n*Returns*: a map describing the update.',
        insertText: 'zoho.crm.updateRecord("${1:Module}", ${2:recordId}, ${3:recordMap})'
    },
    {
        label: 'zoho.crm.deleteRecord',
        detail: 'deleteRecord(module, recordId)',
        documentation: '**zoho.crm.deleteRecord(module, recordId)**\n\nDeletes the record with the given ID.',
        insertText: 'zoho.crm.deleteRecord("${1:Module}", ${2:recordId})'
    },
    {
        label: 'zoho.crm.attachFile',
        detail: 'attachFile(module, recordId, fileObject)',
        documentation: '**zoho.crm.attachFile(module, recordId, fileObject)**\n\nAttaches a file to the given record.',
        insertText: 'zoho.crm.attachFile("${1:Module}", ${2:recordId}, ${3:file})'
    },
    {
        label: 'zoho.crm.updateRelatedRecord',
        detail: 'updateRelatedRecord(parentModule, recordId, relatedModule, dataMap)',
        documentation: '**zoho.crm.updateRelatedRecord(parentModule, recordId, relatedModule, dataMap)**\n\nUpdates a related-list record (e.g. a junction record).',
        insertText: 'zoho.crm.updateRelatedRecord("${1:Module}", ${2:recordId}, "${3:RelatedModule}", ${4:dataMap})'
    }
];

/** Generic builders for the remaining service namespaces (CRUD pattern). */
export const GENERIC_INTEGRATION_FUNCTIONS: DelugeSymbol[] = [
    {
        label: 'zoho.creator.getRecords',
        detail: 'getRecords(appLinkName, reportLinkName, criteria)',
        documentation: '**zoho.creator.getRecords(...)**\n\nFetches records from a Zoho Creator report.',
        insertText: 'zoho.creator.getRecords("${1:appName}", "${2:reportName}", "${3:criteria}")'
    },
    {
        label: 'zoho.creator.createRecord',
        detail: 'createRecord(appLinkName, formLinkName, dataMap)',
        documentation: '**zoho.creator.createRecord(...)**\n\nCreates a record in a Zoho Creator form.',
        insertText: 'zoho.creator.createRecord("${1:appName}", "${2:formName}", ${3:dataMap})'
    },
    {
        label: 'zoho.books.createRecord',
        detail: 'createRecord(module, orgId, dataMap)',
        documentation: '**zoho.books.createRecord(...)**\n\nCreates a record (invoice, contact, etc.) in Zoho Books.',
        insertText: 'zoho.books.createRecord("${1:module}", ${2:orgId}, ${3:dataMap})'
    },
    {
        label: 'zoho.books.getRecords',
        detail: 'getRecords(module, orgId, criteriaMap)',
        documentation: '**zoho.books.getRecords(...)**\n\nFetches records from Zoho Books.',
        insertText: 'zoho.books.getRecords("${1:module}", ${2:orgId})'
    }
];
