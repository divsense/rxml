var fs = require("fs");
var uuid = require("node-uuid");
var R = require("ramda");
var State = require("mond").State;
var parser = require("./rxml.js");

var bodyL = R.lensProp('body');

var imports = 'import {elementOpen,elementClose,elementVoid,text} from "incremental-dom";\nimport * as Rendex from "rendex";';

var renderBranchBegin = 'Rendex.renderBranch({$id, $node, $model, $context, $templates, $options';

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

// getAttr :: String -> [attr] -> [String]
var getAttr = (name,attrs) => R.compose(R.prop('value'),R.find(R.propEq('name',name)))(attrs);

// parseText :: String -> String
parseText = R.compose(
        R.replace( /\{([^=][^{}]+)\}/g, '" + ($1) + "'),
        R.replace( /\{=([^{}]+)\}/g, '$1')
        );

// parseFunc :: String -> String
parseFunc = R.compose( R.replace( "{", '$event=>' ) , R.replace( "}", '' ));

// getDynAttr :: Obj -> [String]
var getDynAttr = a => {
    if (a.name.substr(0, 2) === 'on') {
        return [ '"' + a.name + '"', parseFunc(a.value) ];
    }
    else if (a.name.substr(0, 3) === 'hs-') {
        return [ '"' + a.name.substr(3) + '"', parseText(a.value) ];
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

// gridRow :: node -> State(node, state)
var gridRow = node => State.write(s => {
    var str = 'Rendex.renderSection({$id,$node,$model,$context,$templates,$options},$b,$e)';
	return [node, bodify(str,s)];
});

// branchTerminal :: node -> State(node, state)
var branchTerminal = node => State.write(s => {
    var str = renderBranchBegin;
    if( node.attributes.length ){
        var branchName = getAttr('name', node.attributes);
        if( branchName ){
            str += ', $branchname: "' + branchName + '"';
        }
    }
    str += '});';
	return [node, bodify(str,s)];
});

// ifBegin :: [node] -> State([node], state)
var ifBegin = node => State.write(s => [node, bodify('if(' + getAttr('test', node.attributes) + '){', s)]);

// elseIfBegin :: [node] -> State([node], state)
var elseIfBegin = node => State.write(s => [node, bodify('else if(' + getAttr('test', node.attributes) + '){', s)]);

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
	else if( node.name === 'branchrow' ){
		return R.composeK(goContent, tail(ns), gridRow)(State.of(node));
	}
	else if( node.name === 'branch' ){
		return R.composeK(goContent, tail(ns), branchTerminal)(State.of(node));
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
			return content(ifBegin, closeBrace);
		}
		else if( node.name === 'elseif' ){
			return content(elseIfBegin, closeBrace);
		}
		else if( node.name === 'else' ){
			return content(elseBegin, closeBrace);
		}
        else if( node.name === 'branchgrid' ){
            return content(gridBegin, closeBrace);
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

// defineFunc :: node -> String
var defineFunc = node => {
    var name = node.attributes.find( a => a.name === 'name' );
    var args = "$id, $node, $model, $context, $templates, $options, $index";
    return "export const " + name.value + " = ({" + args + "}) => {";
}

// maybeLog :: node -> String
var maybeLog = node => {
    var log = node.attributes.find( a => a.name === 'log' );
    return log && 'console.log("' + log.value + '",' + log.value + ')';
}

// maybeIf :: node -> String
var maybeIf = node => {
    var i = node.attributes.find( a => a.name === 'if' );
    return i && 'if(!(' + i.value + ')) return;';
}

// templates :: [node] => State([node], state)
var templates = ns => {

	if( ns.length === 0 ){
		return State.of("end");
	}

	var node = ns[0];


    if( node.name === 'template' ){
        return R.composeK( 
				templates,
				tail(ns),
                appendToBody( R.always("}") ),
				of(node),
				goContent,
				of(node.content),
                appendToBody( maybeIf ),
                appendToBody( maybeLog ),
                appendToBody( defineFunc )
				)( State.of(node) );
    }

	return templates( R.tail( ns ) );
}

var translate = R.composeK(templates, globals);

module.exports = function(input){

	var model = parser.parse( input );

	var res = translate( State.of(model) ).run({imports:[imports], globals:[], statics:[], body:[], uid:1, script: false})[ 1 ];

	var output = res.imports.join("\n") + "\n" + res.globals.join("\n") + "\n" + res.statics.join("\n") + "\n" + res.body.join("\n") + "\n";

	return output;
}

