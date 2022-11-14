/*
    Copyright 2017 Esri

    Licensed under the Apache License, Version 2.0 (the 'License');
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at:
    https://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an 'AS IS' BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
*/
require([
  'esri/Map',
  'esri/Basemap',
  'esri/layers/ImageryLayer',
  'esri/layers/support/MosaicRule',
  'esri/layers/BaseDynamicLayer',
  'esri/layers/TileLayer',
  'esri/views/MapView',
  'esri/tasks/ImageServiceIdentifyTask',
  'esri/tasks/support/ImageServiceIdentifyParameters',
  "esri/layers/support/DimensionalDefinition",
  'esri/core/promiseUtils',
  'esri/core/watchUtils',
  'esri/request',
  "dojo/_base/lang",
  'dojo/promise/all',
  "dojox/charting/Chart",
  "dojox/charting/axis2d/Default",
  "dojox/charting/themes/Bahamation",
  "dojox/charting/plot2d/Columns",
  "dojox/charting/action2d/Tooltip",
  'dojo/domReady!'
], function(EsriMap, Basemap,
            ImageryLayer, MosaicRule, BaseDynamicLayer, TileLayer,
            MapView, ImageServiceIdentifyTask, ImageServiceIdentifyParameters, DimensionalDefinition,
            promiseUtils, watchUtils, esriRequest, lang, all,
            Chart, Default, ChartTheme, Columns, ChartTooltip){

  $(document).ready(function(){
    // Enforce strict mode
    'use strict';

    // SERVER OPTIONS //
    const apl_servers = ["apl1", "apl2", "apl22"];
    const getAPLServer = function(avoid){
      let server_idx = -1;
      do {
        server_idx = Math.floor(Math.random() * apl_servers.length);
      } while(apl_servers[server_idx] === avoid);
      return apl_servers[server_idx];
    };
    const apl_server_a = getAPLServer();
    const apl_server_b = getAPLServer(apl_server_a);

    // SERVERS //
    const CLIMATE_URL = "https://geoxc-prod-im.bd.esri.com/arcgis/rest/services/MoraLab/CumulativeHumanImpacts_MD/ImageServer";
    //const CLIMATE_URL = `https://apl.esri.com/${apl_server_a}/rest/services/MoraLab/CumulativeHumanImpacts/ImageServer`;
    const INDEX_URL = `https://apl.esri.com/${apl_server_b}/rest/services/MoraLab/HumanImpacts/ImageServer`;
    //console.info(apl_server_a, CLIMATE_URL);
    //console.info(apl_server_b, INDEX_URL);

    const urlParams = new URLSearchParams(window.location.search);
    if(urlParams.has('APL')){
      CLIMATE_URL = `https://apl.esri.com/apl1/rest/services/MoraLab/CumulativeHumanImpacts/ImageServer`;
      INDEX_URL = `https://apl.esri.com/apl2/rest/services/MoraLab/HumanImpacts/ImageServer`;
    }

    // Constants //
    const CLIMATE_FXN = 'TransRed_Bright';
    const CLIMATE_YEAR = 'F_Date';
    const CLIMATE_RCP = 'RCP';

    const INDEX_VARIABLE = 'Variable';
    const INDEX_EXPERIMENT = 'RCP';
    const INDEX_YEAR = 'Year';

    const VARIABLE_LABEL_BY_NAME = {
      'Floods': 'Floods',
      'Storms': 'Storms',
      'Deforestation': 'Deforestation',
      'Fires': 'Fires',
      'Precipitation': 'Precipitation',
      'SeaLevel': 'Sealevel',
      'HeatWaves': 'Heatwaves',
      'Warming': 'Warming',
      'Drought': 'Drought',
      'OceanClimateIndex': 'Ocean change',
      'WaterScarcity': 'Freshwater deficit'
    };

    const RCP_TO_NAME = {
      '26': 'RCP 2.6',
      '45': 'RCP 4.5',
      '85': 'RCP 8.5'
    };

    // Variables
    let _drag = null;
    let _data = null;

    // Custom layer for processing image server pixels.
    const ImageProcessingLayer = BaseDynamicLayer.createSubclass({
      properties: {
        imageLayer: null,
        colorMap: null
      },
      load: function(){

        this.colorMap = {};

        const getColorMap = esriRequest(this.imageLayer.url + '/rasterAttributeTable', {
          query: {
            'f': 'json',
            'renderingRule': JSON.stringify(this.imageLayer.renderingRule.toJSON())
          }
        }).then(function(response){
          response.data.features.forEach(function(feature){
            this.colorMap[feature.attributes.Value] = feature.attributes;
          }.bind(this));
        }.bind(this));

        this.addResolvingPromise(all([this.imageLayer.load(), getColorMap]));
      },
      fetchImage: function(extent, width, height){
        return this.imageLayer.fetchImage(extent, width, height).then(function(data){

          const pixelBlock = data.pixelData.pixelBlock;
          const numPixels = pixelBlock.width * pixelBlock.height;
          const bands = pixelBlock.pixels;

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;

          const context = canvas.getContext('2d');
          const imageData = context.getImageData(0, 0, width, height);
          const pixels = imageData.data;

          for(let pixel_index = 0; pixel_index < numPixels; pixel_index++){
            const value = bands[0][pixel_index];
            const color = this.colorMap[value] || { Red: 0, Green: 0, Blue: 0, Alpha: 0 };
            pixels[4 * pixel_index] = color.Red || 0;
            pixels[4 * pixel_index + 1] = color.Green || 0;
            pixels[4 * pixel_index + 2] = color.Blue || 0;
            pixels[4 * pixel_index + 3] = color.Alpha || 0;
          }
          context.putImageData(imageData, 0, 0);

          return promiseUtils.resolve(canvas);
        }.bind(this));
      }
    });

    const risk_layer = new ImageProcessingLayer({
      id: 'risk',
      imageLayer: new ImageryLayer({
        format: 'lerc',
        url: CLIMATE_URL,
        renderingRule: { functionName: CLIMATE_FXN },
        mosaicRule: getMosaicRule()
      })
    });

    // Define map
    const _view = new MapView({
      container: 'map',
      extent: {
        xmax: 17219733,
        xmin: -13384429,
        ymax: 13775786,
        ymin: -10918876,
        spatialReference: { wkid: 102100 }
      },
      map: new EsriMap({
        basemap: new Basemap({
          baseLayers: [
            new TileLayer({
              url: 'https://services.arcgisonline.com/arcgis/rest/services/Canvas/World_Dark_Gray_Base/MapServer'
            })
          ],
          title: 'World Dark Gray Base',
          id: 'world-dark-gray-base'
        }),
        layers: [risk_layer]
      }),
      graphics: [
        {
          geometry: {
            type: "point",
            spatialReference: { wkid: 4326 },
            x: -80.198326,
            y: 25.77588
          },
          symbol: {
            type: "picture-marker",
            url: './img/target.png',
            width: '50px',
            height: '50px'
          }
        }
      ],
      constraints: { rotationEnabled: false },
      ui: { components: [] }
    });
    _view.when(function(){

      // TOGGLE LOADING ANIMATION WHEN LAYER IS UPDATING //
      _view.whenLayerView(risk_layer).then(function(layerView){
        watchUtils.init(layerView, "updating", function(updating){
          if(updating){
            $('#loading-map').show();
          } else {
            $('#loading-map').hide();
          }
        });
      });

      // INITIALIZE CHART //
      initChart();
      // Download and display variables.
      downloadVariables();

      // Update the caption text whenever the carousel advances.
      $('#carousel').on('slide.bs.carousel', function(){
        var index = $('#carousel .carousel-item.active').index();
        var len = $('#carousel .carousel-item').length;
        var next1 = index === len - 1 ? 0 : index + 1;
        var next2 = $($('#carousel-captions').children()[next1]);
        next2.addClass('active').siblings().removeClass('active');
      });

      // TOGGLE BOTTOM PANEL //
      $("#bottom-toggle").on("click", function(){
        $("#bottom").toggleClass("collapsed");
        $("#data-scale-container").toggleClass("collapsed");
        setTimeout(function(){
          _hazards_chart && _hazards_chart.resize();
          $("#bottom-toggle").toggleClass("esri-icon-up").toggleClass("esri-icon-down");
        }, 1000);
      });

      // location cursor
      _view.on("pointer-move", function(pointerEvt){
        if(!_drag){
          _view.hitTest(pointerEvt).then(function(hitTest_response){
            _view.container.style.cursor = (hitTest_response.results.length) ? "move" : "default";
          });
        }
      });

      // Location drag behaviour.
      _view.on('drag', function(dragEvt){
        switch(dragEvt.action){
          case 'start':
            _drag = null;
            _view.hitTest({
              x: dragEvt.x,
              y: dragEvt.y
            }).then(function(f){
              if(f && f.results && f.results.length > 0 && f.results[0].graphic.symbol){
                _drag = f.results[0].graphic;
              }
              if(!_drag){ return; }
              dragEvt.stopPropagation();
            });
            break;
          case 'update':
            if(!_drag){ return; }
            dragEvt.stopPropagation();

            var origin = _view.toScreen(_drag.geometry);
            var screenPoint = {
              x: dragEvt.x - (dragEvt.origin.x - origin.x),
              y: dragEvt.y - (dragEvt.origin.y - origin.y)
            };
            _view.graphics.removeAll();
            _view.graphics.add({
              geometry: _view.toMap(screenPoint),
              symbol: _drag.symbol.clone()
            });
            break;
          case 'end':
            if(!_drag){ return; }
            _drag = null;
            downloadVariables();
            break;
        }
      });

      // Location drag behaviour.
      _view.on('click', function(clickEvt){
        const symbol = _view.graphics.getItemAt(0).symbol.clone();
        _view.graphics.removeAll();
        _view.graphics.add({
          geometry: clickEvt.mapPoint,
          symbol: symbol
        });
        downloadVariables();
      });

      // YEAR INPUT CHANGE //
      $('#input-rcp-year').change(function(){
        // Update the image layer mosaic rule.
        _view.map.findLayerById('risk').imageLayer.mosaicRule = getMosaicRule();
        // Force a map refresh.
        _view.extent = _view.extent;
        // Reload chart and table.
        downloadVariables();
      });
      $("#input-rcp-year-labels span").click(function(evt){
        $('#input-rcp-year').val(+evt.currentTarget.innerHTML);
        $('#input-rcp-year').change();
      });

      // RCP SELECT CHANGE //
      $('#select-rcp').change(function(){
        // Update the image layer mosaic rule.
        _view.map.findLayerById('risk').imageLayer.mosaicRule = getMosaicRule();
        // Force a map refresh.
        _view.extent = _view.extent;
        // UPDATE CHART //
        updateChart();
      });

    });

    function getMosaicRule_new(){

      const year = $('#input-rcp-year').val();
      const rcp = $('#select-rcp').val();

      return new MosaicRule({
        multidimensionalDefinition: [
          new DimensionalDefinition({
            variableName: RCP_TO_NAME[rcp],
            dimensionName: "StdTime",
            values: [Date.UTC(Number(year))],
            isSlice: true
          })
        ]
      });
    }

    function getMosaicRule(){
      // if(CLIMATE_URL.includes('geoxc')){ return getMosaicRule_new(); } else {

      const year = $('#input-rcp-year').val();
      const rcp = $('#select-rcp').val();

      return new MosaicRule({
        method: 'attribute',
        ascending: true,
        operation: 'first',
        sortField: CLIMATE_YEAR,
        sortValue: '2094/12/31, 12:00 AM',
        where: lang.replace("{CLIMATE_YEAR} < timestamp '{year}-01-01 08:00:00' AND {CLIMATE_RCP} = '{rcp}'", {
          CLIMATE_YEAR: CLIMATE_YEAR,
          year: year,
          CLIMATE_RCP: CLIMATE_RCP,
          rcp: rcp
        })
      });
      // }
    }

    let _identify_handle;

    function downloadVariables(){
      _identify_handle && (!_identify_handle.isFulfilled()) && _identify_handle.cancel();

      if($("#bottom").hasClass("collapsed")){
        $("#bottom-toggle").click();
      }

      // Initialize data
      _data = new Map();
      _data.set("26", { rcps: [], sum: 0.0 });
      _data.set("45", { rcps: [], sum: 0.0 });
      _data.set("85", { rcps: [], sum: 0.0 });

      // Target location
      const target = _view.graphics.getItemAt(0).geometry;
      $('#hazard-for-coords').html(lang.replace("{lon},{lat}", {
        lon: target.longitude.toFixed(2),
        lat: target.latitude.toFixed(2)
      }));

      // Year
      $('#hazard-for-year-heading').html($('#input-rcp-year').val());

      // YEAR //
      const year = $('#input-rcp-year').val();

      // Construct identify request.
      const parameters = new ImageServiceIdentifyParameters({
        geometry: target,
        returnGeometry: false,
        returnCatalogItems: true,
        mosaicRule: new MosaicRule({
          where: lang.replace("{INDEX_YEAR} = {year}", { INDEX_YEAR: INDEX_YEAR, year: year })
        })
      });


      const identify = new ImageServiceIdentifyTask({ url: INDEX_URL });
      _identify_handle = identify.execute(parameters).then(function(identifyResult){
        const values = identifyResult.properties.Values;
        const features = identifyResult.catalogItems.features;
        features.forEach(function(feature, feature_idx){
          const value = values[feature_idx];

          // GROUP RCPS BY EXPERIMENT AND CALC SUM //
          let experiment = feature.attributes[INDEX_EXPERIMENT];
          // ENTRIES WITH RCP 60 SHOULD BE GROUPED TO RCP 45 //
          experiment = (experiment === "60") ? "45" : experiment;
          const experiment_info = _data.get(experiment);
          if(experiment_info){
            const rcp = isNaN(value) ? 0.0 : Number(value);
            const variable_label = VARIABLE_LABEL_BY_NAME[feature.attributes[INDEX_VARIABLE]];
            experiment_info.rcps.push({
              y: rcp,
              tooltip: lang.replace("{variable_label}<br>{rcp}", { variable_label: variable_label, rcp: rcp.toFixed(3) }),
              variable: variable_label,
              year: feature.attributes[INDEX_YEAR]
            });
            experiment_info.sum += rcp;
            _data.set(experiment, experiment_info);
          }
        }.bind(this));

        // MAG MIN / MAX //
        $("#mag-min").html(_data.get("26").sum.toFixed(1));
        $("#mag-max").html(_data.get("85").sum.toFixed(1));

        // UPDATE CHART //
        updateChart();

      }.bind(this));
    }

    // INITIALIZE CHART //
    let _hazards_chart;
    let _variable_labels;

    function initChart(){

      const fontColor = "#fff";
      const lineStroke = { color: "#fff", width: 1.2 };

      _hazards_chart = new Chart("chart", { margins: { l: 0, r: 0, t: 10, b: 10 } });
      _hazards_chart.setTheme(ChartTheme);
      _hazards_chart.fill = _hazards_chart.theme.plotarea.fill = "transparent";

      _hazards_chart.addPlot("default", {
        type: Columns,
        minBarSize: 15,
        maxBarSize: 30,
        gap: 15
      });

      _hazards_chart.addAxis("y", {
        vertical: true,
        min: -1.0,
        max: 1.0,
        minorTicks: true,
        minorTickStep: 0.2,
        majorTicks: true,
        minorTick: { color: "#fff", length: 5 },
        majorTick: { color: "#fff", length: 8, width: 1.2 },
        stroke: lineStroke,
        htmlLabels: true,
        font: "normal normal normal 9pt Avenir Next W00",
        fontColor: fontColor,
        labelFunc: function(text, value){
          switch(value){
            case 1:
              return lang.replace("Worst case&nbsp;&nbsp;{value}", { value: value.toFixed(0) });
            case -1:
              return lang.replace("Lessening&nbsp;&nbsp;{value}", { value: value.toFixed(0) });
          }
        }
      });

      _hazards_chart.addAxis("x", {
        position: "center",
        stroke: lineStroke,
        minorTicks: true,
        majorTicks: true,
        minorTick: lineStroke,
        majorTick: lineStroke,
        htmlLabels: true,
        rotation: -90,
        font: "normal normal normal 6pt Avenir Next W00",
        fontColor: fontColor,
        dropLabels: false,
        labelSizeChange: false,
        labelFunc: function(text, value){
          return _variable_labels ? _variable_labels[value - 1].text : " ";
        }
      });

      _hazards_chart.addSeries("hazards", [], {
        stroke: { color: "orange", width: 0.0 },
        fill: "orange"
      });

      // CHART TOOLTIPS //
      const chart_tooltip = new ChartTooltip(_hazards_chart);

      // INITIAL RENDER //
      _hazards_chart.render();

      // RESIZE //
      _view.on("resize", function(){
        _hazards_chart.resize();
      });
    }

    function updateChart(){

      const experiment = $('#select-rcp').val();
      const experiment_info = _data.get(experiment);
      if(experiment_info){

        // CHART VALUES //
        const chart_values = experiment_info.rcps.sort(function(a, b){
          return (b.y - a.y);
        });
        // CHART X-AXIS LABELS //
        _variable_labels = chart_values.map(function(chart_value, chart_value_idx){
          return { value: chart_value_idx + 1, text: chart_value.variable };
        });

        _hazards_chart.updateSeries("hazards", chart_values);
        _hazards_chart.fullRender();
      }
    }

  });
});
