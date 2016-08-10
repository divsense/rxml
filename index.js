var fs = require("fs");
var uuid = require("node-uuid");
var R = require("ramda");
var State = require("mond").State;
var parser = require("./rxml.js");

var bodyL = R.lensProp('body');

var imports = 'import {elementOpen,elementClose,elementVoid,text} from "incremental-dom";\nimport * as Rendex from "rendex";';

var getVal = x => x && x.value

// noNils :: [a] -> [a]
var noNils = R.reject(R.isNil);

// tap :: x -> State(x, state)
var of = R.curry((x,_) => State.of(x));

var tail = ns => of(R.tail(ns));

// isTextNode :: node -> Boolean
var isTextNode = R.propEq('type','Text');
	
// isntTextNode :: node -> Boolean
var isntTextNode = R.compose( R.not, isTextNode );

// isTemplate :: [node] => Boolean
var isTemplate = R.pathEq([0,'name'], 'template');

// gtext :: [node] => [String]
var gtext = R.compose( R.map(R.prop('content')), R.filter( isTextNode ) );

// globals :: [node] => State([node], state)
var globals = ns => State.write(s => [R.filter( isntTextNode, ns ), R.over(R.lensProp('globals'), R.concat(gtext(ns)), s)]);

// isDynText :; String -> Boolean
var isDynText = R.test(/\{[^{}]+\}/);

// isDynamicAttr :: Obj -> Boolean
isDynamicAttr = R.compose( isDynText, R.prop('value'));

// getStatAttr :: Obj -> [String]
var getStatAttr = a => [ '"' + a.name + '"', '"' + a.value + '"' ];

// getAttr :: String -> [attr] -> String
var getAttr = (name,attrs) => R.compose( getVal, R.find(R.propEq('name',name)))(attrs);

// makeSignal :: [String] -> String
A
var makeSignal = xs => "$event => document.body.dispatchEvent(new CustomEvent(" + R.trim(R.head(xs)) + ",{detail:" + (R.join("", R.tail(xs)) || 'null') + "}))";

// parseSignal :: String -> String
var parseSignal = R.compose( makeSignal, R.filter(R.compose(R.not, R.isEmpty)), R.split(" "), R.replace( /\{!\s*([^{}]+)\s*\}/, '$1') );

// parseText :: String -> String
var parseText = R.compose(
        R.replace( /\{=\s*([^{} ]+)\s*\}/g, '" + $functions["$1"]($data) + "'),
        R.replace( /\{([^=][^{}]+)\}/g, '" + ($1) + "')
        );

// parseFunc :: String -> String
var parseFunc = R.compose( R.replace( "{", '$event=>' ) , R.replace( "}", '' ));

// getDynAttr :: Obj -> [String]
var getDynAttr = a => {
	if (a.name.substr(0, 2) === 'on') {
		if( /^{!/.test( a.value ) ){
			return [ '"' + a.name + '"', parseSignal(a.value) ];
		}
		return [ '"' + a.name + '"', parseFunc(a.value) ];
	}
	else{
        return [ '"' + a.name + '"', '"' + parseText(a.value) + '"' ];
	}
}

// staticAttrs :: [attr] -> [String]
var staticAttrs = R.compose( R.flatten, R.map(getStatAttr), R.reject(isDynamicAttr) );

// dynamicAttrs :: [attr] -> [String]
var dynamicAttrs = R.compose( R.flatten, R.map(getDynAttr), R.filter(isDynamicAttr) );

// stringify :: [String] -> String
var stringify = R.compose( R.join(","), noNils, R.flatten );

// defStatAttrs :: node -> String -> String
var defStatAttrs = (node, uid) => {
    var sa = staticAttrs( node.attributes );
    if( sa.length ){
        return 'let static_' + uid + ' = ' + '[' + staticAttrs( node.attributes ) + '];';
    }
}

// addAttrs :: node -> String -> String
var addAttrs = (node, uid) => {
    var sa = staticAttrs( node.attributes );
    var da = dynamicAttrs( node.attributes );
    if( sa.length || da.length ){
        var idd = sa.length && uid;
        return [ 
            idd ? "'" + uuid.v4() + "'+$index" : "null",
            idd ? "static_" + idd : "null",
            da.length ? da.join(",") : null
        ];
    }
}

// bodify :: String -> state -> state
var bodify = (str,state) => {
    if( str ){
        return R.over(bodyL, R.append( str ), state );
    }
    return state;
}

// appendToBody :: (node -> String) -> state -> state
var appendToBody = R.curry((fn,node) => State.write(state => [node, bodify(fn(node), state)]));

// elemify :: String -> node -> String -> state
var elemify = (str, node, uid) => R.compose(
      R.over( R.lensProp('uid'), R.inc)
    , R.over( bodyL, R.append(str))
    , R.over( R.lensProp('statics'), R.compose(noNils, R.append(defStatAttrs(node, uid))))
    );

// textElement :: node -> State(_, state)
var textElement = node => State.write(s => [node, bodify(s.script ? node.content : 'text("' + parseText(node.content) + '");', s)]);

// voidElement :: node -> State(_, state)
var voidElement = node => State.write( s => {
    var uid = s.uid;
    var buff = stringify(['elementVoid("' + node.name + '"', addAttrs( node, uid )]) + ");";
    return [node, elemify( buff, node, uid )( s )];
});

// branchTerminal :: node -> State(node, state)
var branchTerminal = node => State.write(s => {
	var str = 'Rendex.renderBranch($data';
    if( node.attributes.length ){
        var branchName = getAttr('name', node.attributes);
        if( branchName ){
            str += ', "' + parseText(branchName) + '"';
        }
        var branchRange = getAttr('range', node.attributes);
		if( branchRange ){
            str += ', [' + parseText(branchRange) + ']';
		}
		else{
			str += ', null';
		}
        var branchFilter = getAttr('filter', node.attributes);
		if( branchFilter ){
            str += ', "' + parseText(branchFilter) + '"';
		}
    }
	str += ");";
	return [node, bodify(str,s)];
});

// includeTemplate :: node -> State(node, state)
var includeTemplate = node => State.write(s => {
    if( node.attributes.length ){
        var tmpl = getAttr('template', node.attributes);
		if( tmpl ){
			var str = 'Rendex.renderTemplate($data,"' + parseText(tmpl) + '");';
			return [node, bodify(str,s)];
		}
    }
	return [node, s];
});

// _begin :: String -> [node] -> State([node], state)
var _begin = name => node => State.write(s => [node, bodify( name + '(' + getAttr('test', node.attributes) + '){', s)]);

// elseBegin :: [node] -> State([node], state)
var elseBegin = node => State.write(s => [node, bodify('else {', s)]);

// gridBegin :: [node] -> State([node], state)
var gridBegin = node => State.write(s => {
    var cols = getAttr('cols', node.attributes);
    return [node, bodify('for(let $i=0,$b=0,$e='+cols+';$i<(1+$node.branch.length/'+cols+');$i++,$b=$i*'+cols+',$e=$b+'+cols+'){let $index=$i;', s)]});

// closeBrace :: [node] -> State([node], state)
var closeBrace = node => State.write(s => [node, bodify('}', s)]);

// compoundElementBegin :: [node] -> State([node], state)
var compoundElementBegin = node => State.write( s => {
    var uid = s.uid;
    var buff = stringify(['elementOpen("' + node.name + '"', addAttrs( node, uid )]) + ");";
    return [node, elemify( buff, node, uid )( s )];
});

// compoundElementEnd :: [node] -> State([node], state)
var compoundElementEnd = node => State.write( s => {
    return [node, R.over( bodyL, R.append( 'elementClose("' + node.name + '");' ), s)];
});

var scriptMode = R.curry((mode,node) => State.write(s => [node, R.set(R.lensProp('script'), mode, s)]));
var scriptBegin = scriptMode(true);
var scriptEnd = scriptMode(false);

// goContent :: [node] => State([node], state)
var goContent = ns => {

	if( ns.length === 0 ){
		return State.of([]);
	}

	var node = ns[0];

	if( node.type === 'Text' ){
		return R.composeK( goContent, tail(ns), textElement )(State.of(node));
	}
	else if( node.name === 'branch' ){
		return R.composeK(goContent, tail(ns), branchTerminal)(State.of(node));
	}
	else if( node.name === 'include' ){
		return R.composeK(goContent, tail(ns), includeTemplate)(State.of(node));
	}
	else if( node.type === 'SelfClosingTag' ){
			return R.composeK( goContent, tail(ns), voidElement )(State.of(node));
	}
	else if( node.type === 'BalancedTag' ){

		var content = (begin,end) => R.composeK( 
					goContent,
					tail(ns),
					end,
					of(node),
					goContent,
					of(node.content),
					begin 
					)(State.of(node));

		if( node.name === 'if' ){
			return content(_begin('if'), closeBrace);
		}
		else if( node.name === 'elseif' ){
			return content(_begin('else if'), closeBrace);
		}
		else if( node.name === 'for' ){
			return content(_begin('for'), closeBrace);
		}
		else if( node.name === 'while' ){
			return content(_begin('while'), closeBrace);
		}
		else if( node.name === 'else' ){
			return content(elseBegin, closeBrace);
		}
        else if( node.name === 'script' ){
            return content(scriptBegin, scriptEnd);
        }
        else{
			return content(compoundElementBegin, compoundElementEnd);
		}
	}
    else if( node.type === 'Comment' ){
        return goContent( R.tail(ns) );
    }
    else{
		return State.of([]);
	}
}

// maybeLog :: node -> String
var maybeLog = node => {
    var log = node.attributes.find( a => a.name === 'log' );
	if( log ){
		var name = getAttr('name', node.attributes);
		return 'console.log("' + name + ': ' + log.value + ' = ",' + log.value + ')';
	}
}

// maybeIf :: node -> String
var maybeIf = node => {
    var i = node.attributes.find( a => a.name === 'if' );
    return i && 'if(!(' + i.value + ')) return;';
}

// defineFunc :: node -> String
var defineFunc = node => {
	var tmplFuncArgs = "$id, $node, $model, $context, $templates, $functions, $options, $siblings, $parent, $index";
    return "export const " + getAttr('name', node.attributes) + " = ($data) => {const {" + tmplFuncArgs + "} = $data;";
}

// templates :: [node] => State([node], state)
var templates = ns => {

	if( ns.length === 0 ){
		return State.of("end");
	}

	var node = R.head(ns);

	var templFunc = R.composeK( 
				templates,
				tail(ns),
                appendToBody( R.always("}") ),
				of(node),
				goContent,
				of(node.content),
                appendToBody( maybeIf ),
                appendToBody( maybeLog ),
                appendToBody( defineFunc )
			);
    return ( node.name === 'template' ) ? templFunc( State.of(node) ) : templates( R.tail( ns ) );

}

var translate = R.composeK(templates, globals);

module.exports = function(input){

	var model = parser.parse( input );

	var res = translate( State.of(model) ).run({imports:[imports], globals:[], statics:[], body:[], uid:1, script: false})[ 1 ];

	var output = res.imports.join("\n") + "\n" + res.globals.join("\n") + "\n" + res.statics.join("\n") + "\n" + res.body.join("\n") + "\n";

	return output;
}

