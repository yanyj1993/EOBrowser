import React from 'react';
import { connect } from 'react-redux';
import moment from 'moment';
import Toggle from 'react-toggle';
import { t } from 'ttag';
import Rodal from 'rodal';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import {
  ApiType,
  MimeTypes,
  isCancelled,
  CancelToken,
  BBox,
  CRS_EPSG4326,
} from '@sentinel-hub/sentinelhub-js';

import store, { modalSlice } from '../../store';
import SlidesSelector from './SlidesSelector';
import SlidesPreview from './SlidesPreview';
import SlidesDownload from './SlidesDownload';
import { layerFromPin, constructSHJSEffects } from '../../Tools/Pins/Pin.utils';
import { getMapDOMSize } from '../../junk/EOBCommon/utils/coords';
import { getAppropriateAuthToken } from '../../App';
import {
  getDataSourceHandler,
  datasourceForDatasetId,
} from '../../Tools/SearchPanel/dataSourceHandlers/dataSourceHandlers';
import { drawMapOverlaysOnCanvas, getScaleBarInfo } from '../ImgDownload/ImgDownload';
import { applyBlobToCanvas } from '../../junk/EOB3TimelapsePanel/imageOverlays.js';
import {
  SENTINEL_COPYRIGHT_TEXT,
  drawCaptions,
  drawLegendImage,
  loadImage,
} from '../../junk/EOB3ImageDownloadPanel/utils/downloadZip';
import { b64EncodeUnicode } from '../../utils/base64MDN';
import { createSVGLegend } from '../ImgDownload/ImgDownload.utils';
import { findMatchingLayerMetadata } from '../../Tools/VisualizationPanel/legendUtils';
import { constructDataFusionLayer } from '../../junk/EOBCommon/utils/dataFusion';
import { isDataFusionEnabled } from '../../utils';

import './PinsStoryBuilder.scss';

const blobToCanvas = async (blob, w, h) => {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  await applyBlobToCanvas(ctx, w, h, blob);
  return canvas;
};

const canvasToBlob = async (canvas, mimeType, qualityArgument = undefined) => {
  return new Promise(resolve => canvas.toBlob(resolve, mimeType, qualityArgument));
};

class PinsStoryBuilder extends React.Component {
  constructor(props) {
    super(props);

    // we put the initial dimensions in state because we don't want them to change with browser resizing:
    const dimensions = this.calculateDimensions();
    const bbox = new BBox(CRS_EPSG4326, ...dimensions.bounds);
    const bboxGeoJSON = bbox.toGeoJSON();
    this.state = {
      slides: this.props.initialPins.map(pin => ({
        pin: pin,
        id: pin._id,
        title: pin.title,
        selected: true,
        imagePromise: null,
        // any pins outside of bounds should be skipped:
        withinBounds: booleanPointInPolygon(
          { type: 'Feature', geometry: { type: 'Point', coordinates: [pin.lng, pin.lat] } },
          bboxGeoJSON,
        ),
      })),
      images: {},
      speedFps: 1,
      imagesOptions: {
        showCaptions: false,
        showSlideDescriptions: false,
        addMapOverlays: true,
        showLegend: false,
      },
      dimensions: dimensions,
      error: null,
    };
  }

  async componentDidMount() {
    this.cancelToken = new CancelToken();
    await this.ensureImages();
  }

  componentWillUnmount() {
    this.cancelToken.cancel();
    const { images } = this.state;
    Object.keys(images).forEach(slideId => {
      URL.revokeObjectURL(images[slideId]);
    });
  }

  calculateDimensions() {
    const { mapBounds } = this.props;
    const { width: mapWidth, height: mapHeight } = getMapDOMSize();

    // If we want to have an image which is smaller than the map, then we get into trouble with
    // overlays. We can't just stretch the map because then the labels and lines will be too small.
    // With bitmap overlays, we could avoid the problems by using a factor 0.5, changing zoom
    // level to zoom - 1 and stretching the result on canvas. With vector overlays the problem is
    // bigger, because we grab whatever Leaflet has drawn on the map (which is of course in original
    // zoom). Stretching the image without changing the zoom level makes roads and borders too thin.
    //
    // The current solution is to not make the image smaller than the map - we use the same size, except
    // that we make the preview smaller via CSS. So even though we distinguish between mapWidth/Height and
    // imageWidth/Height, their values are the same.

    const bounds = [mapBounds.getWest(), mapBounds.getSouth(), mapBounds.getEast(), mapBounds.getNorth()];
    return {
      bounds: bounds,
      imageWidth: mapWidth,
      imageHeight: mapHeight,
      mapWidth: mapWidth,
      mapHeight: mapHeight,
    };
  }

  async createOverlayCanvas(slideTitle, legendUrl, legendDefinition) {
    const {
      slides,
      dimensions: { imageWidth, imageHeight },
      imagesOptions: { showCaptions, addMapOverlays, showSlideDescriptions, showLegend },
    } = this.state;
    const { lat, lng, zoom, enabledOverlaysId } = this.props;

    const canvas = document.createElement('canvas');
    canvas.width = imageWidth;
    canvas.height = imageHeight;
    const ctx = canvas.getContext('2d');

    if (addMapOverlays) {
      await drawMapOverlaysOnCanvas(ctx, lat, lng, zoom, enabledOverlaysId);
    }

    if (showCaptions) {
      const copyrightText = slides.find(
        s => s.withinBounds && s.selected && datasourceForDatasetId(s.pin.datasetId).includes('Sentinel'),
      )
        ? SENTINEL_COPYRIGHT_TEXT
        : '';
      const scaleBar = getScaleBarInfo();
      await drawCaptions(ctx, null, null, copyrightText, scaleBar, true);
    }

    if (showSlideDescriptions) {
      await drawCaptions(ctx, null, slideTitle, null, null, false);
    }

    if (showLegend) {
      const legendImageUrl = legendDefinition
        ? 'data:image/svg+xml;base64,' + b64EncodeUnicode(createSVGLegend(legendDefinition))
        : legendUrl
        ? legendUrl
        : null;
      if (legendImageUrl !== null) {
        const legendImage = await loadImage(legendImageUrl);
        drawLegendImage(ctx, legendImage, true, showCaptions);
      }
    }

    return canvas;
  }

  async ensureImages() {
    this.setState({ error: null });
    try {
      const { auth } = this.props;
      const {
        slides,
        images,
        dimensions: { bounds, imageWidth, imageHeight, mapWidth, mapHeight },
      } = this.state;

      const bbox = new BBox(CRS_EPSG4326, ...bounds);

      for (let i = 0; i < slides.length; i++) {
        const { withinBounds, selected, id: slideId, pin, title } = slides[i];

        if (!withinBounds || !selected || images[slideId]) {
          // nothing to do - not within bounds, not selected or already have an image
          continue;
        }

        const layer = await layerFromPin(pin);
        if (!layer) {
          console.warn('Could not find a suitable layer for pin!', pin);
          continue;
        }

        const { fromTime, toTime, themeId, datasetId, evalscript, evalscripturl, dataFusion } = pin;

        const authToken = getAppropriateAuthToken(auth, themeId);
        const dsh = getDataSourceHandler(datasetId);
        const pinFromTime = fromTime
          ? moment.utc(fromTime).toDate()
          : moment
              .utc(toTime)
              .startOf('day')
              .toDate();
        const pinToTime = fromTime
          ? moment.utc(toTime).toDate()
          : moment
              .utc(toTime)
              .endOf('day')
              .toDate();
        const getMapParams = {
          bbox: bbox,
          fromTime: dsh && dsh.supportsTimeRange() ? pinFromTime : null,
          toTime: pinToTime,
          width: imageWidth,
          height: imageHeight,
          format: MimeTypes.JPEG,
          preview: 2,
          effects: constructSHJSEffects(pin),
        };
        const reqConfig = {
          authToken: authToken,
          cancelToken: this.cancelToken,
        };

        let blob;

        if (isDataFusionEnabled(dataFusion)) {
          const dataFusionLayer = await constructDataFusionLayer(
            layer,
            dataFusion,
            evalscript,
            evalscripturl,
            pinFromTime,
            pinToTime,
          );

          blob = await dataFusionLayer.getHugeMap(getMapParams, ApiType.PROCESSING, reqConfig);
        } else {
          const apiType = layer.supportsApiType(ApiType.PROCESSING) ? ApiType.PROCESSING : ApiType.WMS;
          blob = await layer.getHugeMap(getMapParams, apiType, reqConfig);
        }

        // if there is a predefined layer legend, find it:
        const predefinedLayerMetadata = findMatchingLayerMetadata(pin.datasetId, pin.layerId, pin.themeId);
        const legendDefinition =
          predefinedLayerMetadata && predefinedLayerMetadata.legend
            ? predefinedLayerMetadata.legend
            : layer.legend;
        // apply overlays:
        const overlayCanvas = await this.createOverlayCanvas(title, layer.legendUrl, legendDefinition);
        if (overlayCanvas !== null) {
          const baseCanvas = await blobToCanvas(blob, imageWidth, imageHeight);
          const ctx = baseCanvas.getContext('2d');
          ctx.drawImage(overlayCanvas, 0, 0, mapWidth, mapHeight, 0, 0, imageWidth, imageHeight);
          blob = await canvasToBlob(baseCanvas, 'image/png');
        }

        this.setState(prevState => ({
          images: {
            ...prevState.images,
            [slideId]: URL.createObjectURL(blob),
          },
        }));
      }
    } catch (ex) {
      if (!isCancelled(ex)) {
        console.error(ex);
        this.setState({
          error: ex.toString(),
        });
      }
    }
  }

  onClose = () => {
    store.dispatch(modalSlice.actions.removeModal());
  };

  onToggleSlide = index => {
    this.setState(prevState => {
      const slides = [...prevState.slides];
      slides[index].selected = !slides[index].selected;
      return slides;
    }, this.ensureImages);
  };

  saveNewSlideTitle = (index, title) => {
    this.setState(prevState => {
      const slides = [...prevState.slides];
      slides[index].title = title;
      return slides;
    });
    if (this.state.imagesOptions.showSlideDescriptions) {
      this.resetImages();
    }
  };

  updateSpeedFps = value => {
    this.setState({
      speedFps: Math.max(Math.min(parseInt(value), 10), 1),
    });
  };

  updateImagesOptions = value => {
    this.setState({
      imagesOptions: value,
    });
    this.resetImages();
  };

  resetImages = () => {
    // before resetting the images, make sure we remove all ObjectURLs:
    this.setState(prevState => {
      const { images } = prevState;
      Object.keys(images).forEach(slideId => {
        URL.revokeObjectURL(images[slideId]);
      });
      return {
        images: {},
      };
    }, this.ensureImages);
  };

  render() {
    const {
      slides,
      images,
      speedFps,
      dimensions: { imageWidth, imageHeight },
      error,
      imagesOptions,
    } = this.state;

    const selectedSlides = slides.filter(s => s.withinBounds && s.selected);
    const allImagesDownloaded = selectedSlides.every(s => images[s.id] !== undefined);
    return (
      <Rodal
        animation="slideUp"
        visible={true}
        customStyles={{ height: '95vh', width: '95vw', padding: 0, border: 0 }}
        onClose={this.onClose}
        closeOnEsc={true}
      >
        <div className="pins-story-builder">
          <div className="horizontal-stack">
            <SlidesSelector
              slides={slides}
              onToggleSlide={this.onToggleSlide}
              saveNewSlideTitle={this.saveNewSlideTitle}
            />
            <div className="vertical-stack">
              {allImagesDownloaded ? (
                <>
                  <SlidesPreview
                    selectedSlides={selectedSlides}
                    images={images}
                    updateSpeedFps={this.updateSpeedFps}
                    speedFps={speedFps}
                    imageWidth={imageWidth}
                    imageHeight={imageHeight}
                  />
                  <ImagesOptions values={imagesOptions} onChange={this.updateImagesOptions} />
                  <SlidesDownload
                    selectedSlides={selectedSlides}
                    images={images}
                    speedFps={speedFps}
                    imageWidth={imageWidth}
                    imageHeight={imageHeight}
                    fileName="pins-story"
                  />
                </>
              ) : error ? (
                <div className="error">
                  <i className="fa fa-exclamation-triangle" /> {error}
                </div>
              ) : (
                <i className="fa fa-spinner fa-spin fa-fw downloading-images" />
              )}
            </div>
          </div>
        </div>
      </Rodal>
    );
  }
}

const mapStoreToProps = store => ({
  lat: store.mainMap.lat,
  lng: store.mainMap.lng,
  zoom: store.mainMap.zoom,
  enabledOverlaysId: store.mainMap.enabledOverlaysId,
  initialPins: store.pins.items.map(pi => pi.item),
  mapBounds: store.mainMap.bounds,
  auth: store.auth,
});
export default connect(mapStoreToProps)(PinsStoryBuilder);

class ImagesOptions extends React.Component {
  toggleOption = option => {
    this.props.onChange({
      ...this.props.values,
      [option]: !this.props.values[option],
    });
  };

  render() {
    const { showCaptions, showSlideDescriptions, addMapOverlays, showLegend } = this.props.values;
    return (
      <div className="slides-options">
        <div className="field">
          <label>{t`Show captions`}</label>
          <Toggle checked={showCaptions} icons={false} onChange={() => this.toggleOption('showCaptions')} />
        </div>
        <div className="field">
          <label>{t`Show slide descriptions`}</label>
          <Toggle
            checked={showSlideDescriptions}
            icons={false}
            onChange={() => this.toggleOption('showSlideDescriptions')}
          />
        </div>
        <div className="field">
          <label>{t`Add map overlays`}</label>
          <Toggle
            checked={addMapOverlays}
            icons={false}
            onChange={() => this.toggleOption('addMapOverlays')}
          />
        </div>
        <div className="field">
          <label>{t`Show legend`}</label>
          <Toggle checked={showLegend} icons={false} onChange={() => this.toggleOption('showLegend')} />
        </div>
      </div>
    );
  }
}
