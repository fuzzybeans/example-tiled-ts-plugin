/// <reference types="@mapeditor/tiled-api" />

type JsonPrimitive = string | number | boolean | null;
type JsonArray = JsonValue[];
type JsonObject = { [key: string]: JsonValue };
type JsonValue = JsonPrimitive | JsonArray | JsonObject;

const DELIMITER = "\t";
const PAD = 4;
const wrap_lk = new Map();
const inline_lk = new Map();

function luafyJsonArray(json:JsonArray, depth:number):string {
    const n = json.length;

    if (n === 0) {
        return "{}";
    }

    let newdepth = depth + 1;
    let values = `{\n`;
    let wrapwidth = 10;

    if (wrap_lk.get(json) !== undefined) {
        wrapwidth = wrap_lk.get(json);
    }

    const isNumericArray = typeof json[0] === "number";

    if (isNumericArray) {
        for (let i = 0; i < n; ++i) {
            if (i % wrapwidth === 0) {
                values += DELIMITER.repeat(newdepth);
            }

            values += `${String(json[i]).padStart(PAD)}`;

            if (i < n - 1) {
                values += ",";

                if ((i + 1) % wrapwidth !== 0) {
                    values += " ";
                }
            }

            if ((i + 1) % wrapwidth === 0 && i !== n - 1) {
                values += "\n";
            }
        }
    } else {
        for (let i = 0; i < n; ++i) {
            values += luafyAny(json[i], newdepth);

            if (i < n - 1) {
                values += ",";
            }

            if (i !== n - 1) {
                values += "\n";
            }
        }
    }

    values += `\n${DELIMITER.repeat(depth)}}`;

    return values;
}

function luafyJsonObject(json:JsonObject, depth:number, ignoreNesting:boolean=false):string {
    const newdepth = depth + 1;
    let values = "";

    if (!ignoreNesting) {
        values += `${DELIMITER.repeat(depth)}`;
    }

    values += `{`;

    const n = Object.keys(json).length;
    let i = 0;
    const isInline = inline_lk.get(json) !== undefined;

    if (isInline) {
        values += " ";
    } else {
        values += "\n";
    }

    for (const [key, value] of Object.entries(json)) {
        if (isInline) {
            values += `${key} = ${luafyAny(value, newdepth)}`;

            if (i < n - 1) {
                values += ", ";
            }
        } else {
            values += `${DELIMITER.repeat(newdepth)}${key} = ${luafyAny(value, newdepth, true)}`;

            if (i < n - 1) {
                values += ",\n";
            }
        }

        ++i;
    }

    if (isInline) {
        values += " }";
    } else {
        values += `\n${DELIMITER.repeat(depth)}}`;
    }

    return values;
}

function luafyJsonPrimitive(json:JsonPrimitive):string {
    let values = "";

    if (typeof json === "string") {
        values += `"${json}"`;
    } else if (json === null) {
        values += "nil";
    } else {
        values += json;
    }

    return values;
}

function luafyAny(json:JsonValue, depth:number, ignoreNesting:boolean=false) {
    if (Array.isArray(json)) {
        return luafyJsonArray(json, depth);
    }

    if (typeof json === "object" && json !== null && !Array.isArray(json)) {
        return  luafyJsonObject(json, depth, ignoreNesting);
    }
    
    if (
        typeof json === "string"  || 
        typeof json === "number"  || 
        typeof json === "boolean" || 
        json === null
    ) {
       return luafyJsonPrimitive(json);
    }

    return "";
}

function json2lua(json:JsonObject) : string {
    let values = luafyAny(json, 0);
    return `return ${values}`;
}

function extractTiledObjects(mapObjects: MapObject[]):JsonArray {
    const objects:JsonArray = [];

    mapObjects.forEach(mapObject => {
        const object:JsonObject = {
            id: mapObject.id,
            shape: ""
        };

        if (mapObject.shape === MapObject.Rectangle) {
            object.shape = "rectangle";
            object.x = mapObject.x;
            object.y = mapObject.y;
            object.width = mapObject.width;
            object.height = mapObject.height;
        } else if (mapObject.shape === MapObject.Polygon) {
            object.shape = "polygon";
            object.polygon = mapObject.polygon.map(poly => { 
                const vertices = { x: poly.x, y: poly.y };

                // Add each vertex to a lookup so that later we know to just keep all the info on one line when stringifying it.

                inline_lk.set(vertices, true);

                return vertices;
            });
        }

        if (object.shape !== "") {
            objects.push(object);
        }
    });

    return objects;
}

function pick(map:TileMap):JsonObject {
    // We don't need all of the bloat that comes with a Tiled export by default.

    const {width, height, tileWidth, tileHeight, tilesets:mapTilesets, layers:mapLayers} = map;

    // On the top-level, we'll just take the width/height of the map in tiles, and the width/height in pixels of the tiles.

    const json:JsonObject = {
        width,
        height,
        tilewidth: tileWidth,
        tileheight: tileHeight
    };

    const parsedTilesets:JsonArray = [];
    const parsedLayers:JsonArray = [];

    // For tilesets, we'll just take name, tile count, first tile ID in the tileset, and we'll use just the image name from the full directory path.
    // Each tile set may define collision geometry separately on each tile, as well.

    for (let i = 0; i < mapTilesets.length; ++i) {
        const {name, imageFileName, tileCount:tilecount, tiles:mapTiles, nextTileId} = mapTilesets[i];
        const splitImage = imageFileName.split("/");
        const image = splitImage.pop() ?? "";
        const firstgid = nextTileId - tilecount + 1;

        const tileset:JsonObject = {
            name,
            tilecount,
            firstgid,
            image
        };

        const parsedTiles:JsonArray = [];

        mapTiles.forEach(mapTile => {
            if (mapTile.objectGroup === null || mapTile.objectGroup.objectCount === 0) {
                return;
            }

            const objects = extractTiledObjects(mapTile.objectGroup.objects);

            const tile:JsonObject = {
                id: mapTile.id,
                objectGroup: {
                    objects
                }
            };

            parsedTiles.push(tile);
        });

        tileset.tiles = parsedTiles;

        parsedTilesets.push(tileset); 
    }

    json.tilesets = parsedTilesets;

    // For each layer, we want ID, name, and type.
    // If it's a "tile layer" type, then we'll add the tile IDs drawn to the layer. 
    // If it's an "object layer" type, then add the individual shape objects defined in the layer.

    for (let i = 0; i < mapLayers.length; ++i) {
        const mapLayer = map.layerAt(i);

        const layer:JsonObject = {
            id: mapLayer.id,
            name: mapLayer.name,
            type: ""
        };

        // There's probably a better way to do this with type safety.

        if (mapLayer.isTileLayer) {
            const tilelayer = mapLayer as TileLayer;

            layer.type = "tilelayer";
            layer.width = tilelayer.width;
            layer.height = tilelayer.height;
            layer.data = [];

            // Add a reference to the "data" array to a lookup, so that later we know to wrap it on its column width when stringifying it.

            wrap_lk.set(layer.data, tilelayer.width);

            for (let i = 0; i < tilelayer.height; ++i) {
                for (let j = 0; j < tilelayer.width; ++j) {
                    if (Array.isArray(layer.data)) {
                        let tile = tilelayer.tileAt(j, i);
                        if (tile !== null) {
                            layer.data.push(tile.id + 1);
                        } else {
                            layer.data.push(0);
                        }
                    }
                }
            }
        } else if (mapLayer.isObjectLayer) {
            const objectlayer = mapLayer as ObjectGroup;

            layer.type = "objectgroup";
            layer.objects = extractTiledObjects(objectlayer.objects);
        }

        if (layer.type !== "") {
            parsedLayers.push(layer);
        }
    }

    json.layers = parsedLayers;

    // TODO: custom properties on individual layers or tiles

    return json;
}

const lightLuaMapFormat: ScriptedMapFormat = {
    name: "Light Lua",
    extension: "lua",
    write: function(map: TileMap, fileName: string) {
        const json = pick(map); // take only the stuff we need from the exported map
        const luastring = json2lua(json); // sloppily turn it into lua
        const file = new TextFile(fileName, TextFile.WriteOnly);
        file.write(luastring);
        file.commit();
    },
};

tiled.registerMapFormat("light-lua-map-format", lightLuaMapFormat);