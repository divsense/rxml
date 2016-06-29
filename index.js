var fs = require("fs");
var R = require("ramda");
var State = require("momon").State;
var parser = require("./rxml.js");

var bodyL = R.lensProp('body');

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

// isDynamicAttr :: Obj -> Boolean
isDynamicAttr = R.compose(R.test(/[{}]+/), R.prop('value'));

// getAttr :: Obj -> [String]
var getAttr = a => [ '"' + a.name + '"', '"' + a.value + '"' ];

// staticAttrs :: [attr] -> [String]
var staticAttrs = R.compose( R.flatten, R.map(getAttr), R.reject(isDynamicAttr) );

// dynamicAttrs :: [attr] -> [String]
var dynamicAttrs = R.compose( R.flatten, R.map(getAttr), R.filter(isDynamicAttr) );

// stringify :: [String] -> String
var stringify = R.compose( R.join(","), noNils, R.flatten );

// defStatAttrs :: node -> String -> String
var defStatAttrs = (node, uid) => {

    var sa = staticAttrs( node.attributes );
    if( sa.length ){
        return 'var static_' + uid + ' = ' + '[' + staticAttrs( node.attributes ) + '];';
    }

}
// addAttrs :: node -> String -> String
var addAttrs = (node, uid) => {

    var sa = staticAttrs( node.attributes );
    var da = dynamicAttrs( node.attributes );

    if( sa.length || da.length ){

        var idd = sa.length && uid;

        return [ 
            idd ? '"' + idd + '"' : "null",
            idd ? "static_" + idd : "null",
            da.length ? da.join(",") : null
        ];

    }
}

// bodify :: String -> state -> state
var bodify = (str,state) => R.compose( R.over(bodyL, R.append( str )) )( state );

// elemify :: String -> node -> String -> state
var elemify = (str, node, uid) => R.compose(
      R.over( R.lensProp('uid'), R.inc)
    , R.over( bodyL, R.append(str))
    , R.over( R.lensProp('statics'), R.compose(noNils, R.append(defStatAttrs(node, uid))))
    );

// appendToBody :: String -> state -> state
var appendToBody = R.curry((str,state) => [[],bodify(str,state)]);

// textElement :: node -> State(_, state)
var textElement = node => State.write(appendToBody("text(" + node.content + ");"));

// voidElement :: node -> State(_, state)
var voidElement = node => State.write( s => {

    var uid = s.uid;

    var buff = stringify(['elementVoid(' + node.name, addAttrs( node, uid )]) + ");";

    return [node, elemify( buff, node, uid )( s )];
});

// compoundElement :: [node] -> State([node], state)
var compoundElementBegin = node => State.write( s => {
    var uid = s.uid;
    var buff = stringify(['elementOpen(' + node.name, addAttrs( node, uid )]) + ")";
    return [node, elemify( buff, node, uid )( s )];
});

var compoundElementEnd = node => State.write( s => {
    return [node, R.over( bodyL, R.append( 'elementClose(' + node.name + ');' ), s)];
});

// goContent :: [node] => State([node], state)
var goContent = ns => {

	if( ns.length === 0 ){
		return State.of([]);
	}

	var node = ns[0];

	if( node.type === 'Text' ){
		return R.composeK( goContent, tail(ns), textElement )(State.of(node));
	}
	else if( node.type === 'SelfClosingTag' ){
		return R.composeK( goContent, tail(ns), voidElement )(State.of(node));
	}
	else if( node.type === 'BalancedTag' ){
		return R.composeK( 
			   	goContent,
				tail(ns),
				compoundElementEnd,
				of(node),
			   	goContent,
				of(node.content),
			   	compoundElementBegin 
				)(State.of(node));
	}
	else{
		return State.of([]);
	}
}

// defineFunc :: node -> String
var defineFunc = node => {
    var name = node.attributes.find( a => a.name === 'name' );
    var args = "$id, $model, $context, $templates, $options";
    return "export const " + name.value + " = ({" + args + "}) => {";
}

// beginTemplateFunc :: node => State(_, state)
var beginTemplateFunc = node => State.write(appendToBody(defineFunc(node)));

// endTemplateFunc :: node => State(_, state)
//var endTemplateFunc = node => State.write(appendToBody( "}", R.tail(ns)) );
var endTemplateFunc = node => State.write(appendToBody( "}"));

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
				endTemplateFunc,
				of(node),
				goContent,
				of(node.content),
			   	beginTemplateFunc
				)( State.of(node) );
    }

	return templates( R.tail( ns ) );
}

var translate = R.composeK(templates, globals);

var input = fs.readFileSync("./test.html", {encoding: 'utf8'});
var model = parser.parse( input );

console.log( model );

var res = translate( State.of(model) ).run({globals:[], statics:[], body:[],uid:1})[ 1 ];

console.log( res );

var buff = "\n\n" + res.globals.join("\n") + "\n" + res.statics.join("\n") + "\n" + res.body.join("\n") + "\n";

console.log( buff );

//module.exports = function(opts){
//}

